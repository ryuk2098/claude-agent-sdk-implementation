import logging
import os
import json
from datetime import datetime
from typing import Any, Dict, Optional

# Log directory — /var/log/app/ is writable by appuser but outside
# both /app and /workspace, so the agent cannot access it via hooks.
LOG_DIR = os.environ.get("LOG_DIR", "/var/log/app")
os.makedirs(LOG_DIR, exist_ok=True)

# Configure basic logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),  # Console handler
        logging.FileHandler(
            filename=os.path.join(LOG_DIR, 'app.log'),
            encoding='utf-8',
        ),
    ]
)

# Create logger
logger = logging.getLogger(__name__)

class LocalLogger:
    """Helper class for local and detailed logging"""

    def __init__(self, log_dir: str = LOG_DIR):
        """
        Initialize the local logger
        
        Args:
            log_dir: Directory to store log files
        """
        self.log_dir = log_dir
        self._ensure_log_directory()
        
    def _ensure_log_directory(self):
        """Ensure log directory exists"""
        if not os.path.exists(self.log_dir):
            os.makedirs(self.log_dir)
            
    def _get_log_filename(self, prefix: str) -> str:
        """
        Generate a log filename based on prefix and current date
        
        Args:
            prefix: Prefix for the log file
            
        Returns:
            Log filename
        """
        current_date = datetime.now().strftime("%Y-%m-%d")
        return f"{self.log_dir}/{prefix}_{current_date}.log"
    
    def log_workflow_step(self, 
                          step_name: str, 
                          conversation_id: str, 
                          user_message: str, 
                          context: Optional[str] = None,
                          output: Optional[str] = None):
        """
        Log workflow step information to a local file
        
        Args:
            step_name: Name of the workflow step
            conversation_id: Conversation ID
            user_message: User's message
            context: Additional context information
            output: Output of the step
        """
        log_filename = self._get_log_filename("workflow")
        
        timestamp = datetime.now().isoformat()
        
        log_entry = {
            "timestamp": timestamp,
            "step": step_name,
            "conversation_id": conversation_id,
            "user_message": user_message
        }
        
        if context:
            log_entry["context"] = context
            
        if output:
            log_entry["output"] = output
        
        with open(log_filename, 'a', encoding='utf-8') as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')
            
        # Also log to standard logger
        logger.info(f"Workflow step '{step_name}' for conversation '{conversation_id}'")
    
    def log_conversation(self, 
                         conversation_id: str, 
                         email: str, 
                         user_message: str,
                         assistant_response: str):
        """
        Log conversation information to a local file
        
        Args:
            conversation_id: Conversation ID
            email: User's email
            user_message: User's message
            assistant_response: Assistant's response
        """
        log_filename = self._get_log_filename("conversation")
        
        timestamp = datetime.now().isoformat()
        
        log_entry = {
            "timestamp": timestamp,
            "conversation_id": conversation_id,
            "email": email,
            "user_message": user_message,
            "assistant_response": assistant_response
        }
        
        with open(log_filename, 'a', encoding='utf-8') as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')
            
        # Also log to standard logger
        logger.info(f"Conversation logged for ID '{conversation_id}', email '{email}'")
    
    def log_error(self, 
                  error_type: str, 
                  conversation_id: Optional[str] = None, 
                  error_message: str = "",
                  details: Optional[Dict[str, Any]] = None):
        """
        Log error information to a local file
        
        Args:
            error_type: Type of error
            conversation_id: Conversation ID (if applicable)
            error_message: Error message
            details: Additional error details
        """
        log_filename = self._get_log_filename("error")
        
        timestamp = datetime.now().isoformat()
        
        log_entry = {
            "timestamp": timestamp,
            "error_type": error_type,
            "error_message": error_message
        }
        
        if conversation_id:
            log_entry["conversation_id"] = conversation_id
            
        if details:
            log_entry["details"] = details
        
        with open(log_filename, 'a', encoding='utf-8') as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')
            
        # Also log to standard logger
        logger.error(f"Error '{error_type}': {error_message}")

# Create singleton instance
local_logger = LocalLogger()

# Export the standard logger and local logger
__all__ = ['logger', 'local_logger']