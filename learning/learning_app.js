console.log("Java app is running yay");

let messageElement = document.getElementById("message");
messageElement.textContent = "changed text";

console.log("done with the app, check for changed text")

let messageRotary = 0;

function changeText() {
    if (messageRotary == 0) {
        messageElement.textContent = "text changed hehe";
        messageRotary = 1;
    }
    else {
        messageElement.textContent = "changed text";
        messageRotary = 0;
    }
    console.log("button clicked, text changed");
}
