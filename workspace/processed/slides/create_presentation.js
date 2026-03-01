const pptxgen = require('pptxgenjs');
const html2pptx = require('/Users/akashmaggon/.claude/skills/pptx/scripts/html2pptx');
const path = require('path');

async function createPresentation() {
    const pptx = new pptxgen();
    pptx.layout = 'LAYOUT_16x9';
    pptx.title = 'Simple Two-Slide Presentation';
    pptx.author = 'Doc Agent';

    const slidesDir = __dirname;

    // Slide 1: Title
    await html2pptx(path.join(slidesDir, 'slide1.html'), pptx);

    // Slide 2: Content
    await html2pptx(path.join(slidesDir, 'slide2.html'), pptx);

    const outputPath = path.join(
        '/Users/akashmaggon/Desktop/Projects/Skills and Claude Code/doc-agent/workspace/processed',
        'simple_presentation.pptx'
    );

    await pptx.writeFile({ fileName: outputPath });
    console.log('Presentation created:', outputPath);
}

createPresentation().catch(console.error);
