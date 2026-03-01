"""
Claude Agent integration using the Claude Agent SDK.

Uses query() with:
  - bypassPermissions  → autonomous execution (sandboxed in Docker)
  - PreToolUse hook    → blocks file deletions + enforces per-session file isolation
  - setting_sources    → loads Skills from .claude/skills/
  - session resumption → user can continue a prior conversation
  - pre-generated IDs  → session IDs are created before query() starts
  - history tracking   → conversation turns are persisted per session
"""

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from claude_agent_sdk import (
    ClaudeAgentOptions,
    HookMatcher,
    ResultMessage,
    SystemMessage,
    query,
)

from app.hooks import block_deletions, enforce_file_isolation
from app.session_store import (
    add_history_entry,
    create_session,
    generate_session_id,
    get_history,
    get_session,
    session_exists,
    update_session,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Fix: Allow running locally inside a Claude Code terminal session.
# ---------------------------------------------------------------------------
if "CLAUDECODE" in os.environ:
    del os.environ["CLAUDECODE"]

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
WORKSPACE_DIR = Path(os.getenv("WORKSPACE_DIR", "./workspace")).resolve()
UPLOADS_DIR = WORKSPACE_DIR / "uploads"
PROCESSED_DIR = WORKSPACE_DIR / "processed"

SYSTEM_PROMPT_APPEND = """
You are a document processing agent.

Uploaded files (read-only source documents) are in: {uploads_dir}
Your output directory for this session is: {session_dir}

RULES:
- You MUST NEVER delete any files. Only read, copy, edit, and create.
- When editing a document, always make a copy first and edit the copy.
- Save ALL outputs to your session output directory: {session_dir}
- You may READ files from the uploads directory but NEVER write there.
- Use the available Skills to read .pptx, .docx, and .xlsx files.
- Be thorough and report what you did after completing a task.
""".strip()

HISTORY_PREAMBLE = """
--- Previous conversation history for this session ---
{history_text}
--- End of previous history ---
""".strip()


# ---------------------------------------------------------------------------
# History formatter
# ---------------------------------------------------------------------------

def _format_history(history: list[dict]) -> str:
    """Format stored history entries into a readable text block."""
    if not history:
        return ""
    lines = []
    for entry in history:
        role = entry["role"].upper()
        content = entry["content"]
        ts = entry.get("timestamp", "")
        lines.append(f"[{role}] ({ts})\n{content}")
    return "\n\n".join(lines)


# ---------------------------------------------------------------------------
# Agent options builder
# ---------------------------------------------------------------------------

def _build_options(
    app_session_id: str,
    session_dir: Path,
    sdk_session_id: str | None = None,
    history: list[dict] | None = None,
) -> ClaudeAgentOptions:
    """Build ClaudeAgentOptions with hooks, permissions, and Skills."""
    logger.info(f"Building options — session={app_session_id}, cwd={session_dir}")

    # Build the system prompt with optional history context
    append_parts = [
        SYSTEM_PROMPT_APPEND.format(
            uploads_dir=UPLOADS_DIR,
            session_dir=session_dir,
        )
    ]

    if history:
        history_text = _format_history(history)
        append_parts.append(HISTORY_PREAMBLE.format(history_text=history_text))

    append_text = "\n\n".join(append_parts)

    # Create a closure that captures the allowed paths for this session
    async def session_file_isolation(input_data, tool_use_id, context):
        return await enforce_file_isolation(
            input_data, tool_use_id, context,
            allowed_write_dir=str(session_dir),
            allowed_read_dirs=[str(UPLOADS_DIR), str(session_dir)],
        )

    opts = ClaudeAgentOptions(
        # Working directory is the session-specific processed dir
        cwd=str(session_dir),

        # Full Claude Code system prompt + our custom rules appended
        system_prompt={
            "type": "preset",
            "preset": "claude_code",
            "append": append_text,
        },

        # Load Skills from .claude/skills/ (user and project level)
        setting_sources=["user", "project"],

        # Autonomous — no human-in-the-loop permission prompts
        permission_mode="bypassPermissions",

        # Tools the agent can use
        allowed_tools=[
            "Skill",    # Invoke Skills for document parsing
            "Read",     # Read file contents
            "Write",    # Create new files
            "Edit",     # Edit existing files
            "Bash",     # Run shell commands (copying files, etc.)
            "Glob",     # Find files by pattern
            "Grep",     # Search file contents
        ],

        # Safety hooks: deletion prevention + file isolation
        hooks={
            "PreToolUse": [
                HookMatcher(matcher="Bash|Write|Edit", hooks=[
                    block_deletions,
                    session_file_isolation,
                ]),
            ],
        },

        # Safety: cap turns to prevent runaway execution
        max_turns=25,
    )

    # Resume via the SDK's internal session ID (not our app session ID)
    if sdk_session_id:
        opts.resume = sdk_session_id

    return opts


# ---------------------------------------------------------------------------
# Result container
# ---------------------------------------------------------------------------

@dataclass
class AgentResult:
    session_id: str          # Our pre-generated app session ID
    sdk_session_id: str      # The SDK's internal session ID (for resume)
    result: str
    files_modified: list[str]
    history: list[dict]


# ---------------------------------------------------------------------------
# Run the agent
# ---------------------------------------------------------------------------

async def run_agent(instruction: str, session_id: str | None = None) -> AgentResult:
    """
    Execute a one-shot agent query.

    Args:
        instruction: Natural language instruction from the user.
        session_id:  Pre-generated app session ID. None = create a new session.

    Returns:
        AgentResult with session_id, sdk_session_id, result text,
        list of files modified, and conversation history.
    """

    # --- 1. Session setup ---------------------------------------------------
    is_new = session_id is None or not session_exists(WORKSPACE_DIR, session_id)

    if session_id is None:
        session_id = generate_session_id()

    if is_new:
        create_session(WORKSPACE_DIR, session_id)
        sdk_session_id = None
        history = []
    else:
        session_data = get_session(WORKSPACE_DIR, session_id)
        sdk_session_id = session_data.get("sdk_session_id")
        history = session_data.get("history", [])

    # --- 2. Ensure session-specific output directory exists ------------------
    session_dir = PROCESSED_DIR / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    # --- 3. Build options and run -------------------------------------------
    options = _build_options(
        app_session_id=session_id,
        session_dir=session_dir,
        sdk_session_id=sdk_session_id,
        history=history if sdk_session_id is None and history else None,
        # Only inject history text for sessions that can't be SDK-resumed.
        # When SDK resume works, the agent already has full context internally.
    )

    # Log the user instruction
    add_history_entry(WORKSPACE_DIR, session_id, role="user", content=instruction)

    captured_sdk_session_id: str = sdk_session_id or ""
    result_text: str = ""

    logger.info(f"Running agent — session={session_id}, instruction={instruction[:80]}...")

    try:
        async for message in query(prompt=instruction, options=options):
            # Capture SDK session ID from the init message
            if isinstance(message, SystemMessage) and message.subtype == "init":
                captured_sdk_session_id = message.data.get(
                    "session_id", captured_sdk_session_id
                )

            # Capture the final result
            if isinstance(message, ResultMessage) and message.subtype == "success":
                result_text = message.result or ""

    except Exception as e:
        # Log the error in history
        add_history_entry(
            WORKSPACE_DIR, session_id, role="error", content=str(e),
        )
        if sdk_session_id:
            logger.error(f"Failed to resume session {session_id}: {e}")
            raise ValueError(
                f"Failed to resume session '{session_id}'. "
                "It may not exist or is invalid."
            ) from e
        raise

    # --- 4. Persist results -------------------------------------------------
    # Log agent response in history
    add_history_entry(WORKSPACE_DIR, session_id, role="assistant", content=result_text)

    # Save the SDK session ID so we can resume next time
    update_session(
        WORKSPACE_DIR,
        session_id,
        sdk_session_id=captured_sdk_session_id,
    )

    # Scan the session output directory for files
    files_modified = []
    if session_dir.exists():
        files_modified = [
            str(p) for p in session_dir.rglob("*") if p.is_file()
        ]

    # Return fresh history
    updated_history = get_history(WORKSPACE_DIR, session_id)

    return AgentResult(
        session_id=session_id,
        sdk_session_id=captured_sdk_session_id,
        result=result_text,
        files_modified=files_modified,
        history=updated_history,
    )
