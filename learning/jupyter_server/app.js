console.log("Monaco Editor loaded");

// let editor;

// Initialize Monaco Editor
require.config({ 
    paths: { 
        vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.34.0/min/vs' 
    } 
});

require(['vs/editor/editor.main'], function() {
    window.editor = monaco.editor.create(document.getElementById('editor'), {
        // value: `# COMPAS Studio Online\n# The kernel persists state across runs\n\nfrom compas.geometry import Box\n\nbox = Box.from_width_height_depth([0,0,0], 2, 1, 1)\nprint(f"Box created: {box}")`,
        language: 'python',
        theme: 'vs',
        fontSize: 14
    });

    let typingTimeout;
    const typingDelay = 3000;
    window.editor.onDidChangeModelContent(() => {
        if (liveCodeEnabled) {
            clearTimeout(typingTimeout);
            typingTimeout = setTimeout(runCode, typingDelay);
        }
    });

});


let liveCodeEnabled = false;

const checkbox = document.getElementById('run-toggle');
const runButton = document.getElementById('run-file');

checkbox.addEventListener('change', function() {
    if (this.checked) {
        runButton.disabled = true;
        liveCodeEnabled = true;
    } else {
        runButton.disabled = false;
        liveCodeEnabled = false;
    }
});


async function runCode() {
    // debugger;
    const code = window.editor.getValue();
    const outputDiv = document.getElementById('output');
    
    outputDiv.textContent = 'Running...';
    
    try {
        const response = await fetch('/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: code })
        });
        
        const result = await response.json();
        
        if (result.success) {
            outputDiv.textContent = result.output || '(No output)';
        } else {
            outputDiv.textContent = 'ERROR:\n' + result.error;
        }
            
    } catch (error) {
        outputDiv.textContent = 'Connection failed: ' + error.message;
    }
}