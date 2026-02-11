// livetoggle.js
// console.log("livetoggle.js loaded");

const checkbox = document.getElementById('run-toggle');
const runButton = document.getElementById('run-file');

checkbox.addEventListener('change', function() {
    // Change the name based on whether checkbox is checked
    if (this.checked) {
        runButton.disabled = true;
    } else {
        runButton.disabled = false;
    }
});


// document.addEventListener('DOMContentLoaded', function() {
//     // Get all three elements
//     const runToggle = document.getElementById('run-toggle');
//     const runButton = document.getElementById('run-file');
//     const liveButton = document.getElementById('live-toggle');
    
//     // Function to update all elements based on toggle state
//     function updateUI() {
//         if (runToggle.checked) {
//             // Toggle is ON
//             runButton.disabled = false;  // Run button is active
//             liveButton.textContent = "Live Mode: On";
//             liveButton.className = "live-on";
//         } else {
//             // Toggle is OFF
//             runButton.disabled = true;   // Run button is greyed out
//             liveButton.textContent = "Live Mode: Off";
//             liveButton.className = "live-off";
//         }
//     }
    
//     // Add event listener to the toggle
//     if (runToggle && runButton && liveButton) {
//         runToggle.addEventListener('change', updateUI);
        
//         // Initialize the UI state
//         updateUI();
//     }
    
//     // Optional: Add click handler for the live button to toggle it
//     liveButton.addEventListener('click', function() {
//         // Toggle the checkbox when live button is clicked
//         runToggle.checked = !runToggle.checked;
//         updateUI();
//     });
    
//     // Example runCode function (if you need it)
//     window.runCode = function() {
//         const output = document.getElementById('output');
//         output.textContent = "Code executed at: " + new Date().toLocaleTimeString();
//     };
// });