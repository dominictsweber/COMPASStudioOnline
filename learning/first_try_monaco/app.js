console.log("Java app is running yay");

let editor; // Will store the Monaco editor instance

// Initialize Monaco Editor
require.config({ 
    paths: { 
        vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.34.0/min/vs' 
    } 
});

require(['vs/editor/editor.main'], function() {
    editor = monaco.editor.create(document.getElementById('editor'), {
        value: `# Test COMPAS\nprint("Hello!")\n\n# Try COMPAS:\n# from compas.geometry import Box`,
        language: 'python',
        theme: 'vs-light',
        fontSize: 14
    });
});

async function runCode() {
    const code = editor.getValue();
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