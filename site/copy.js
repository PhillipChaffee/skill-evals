/* global document, navigator, setTimeout */

// The copy button starts hidden in the HTML, so a page without this script
// shows no button that does nothing.
const RESET_AFTER_MS = 2000;

for (const button of document.querySelectorAll("[data-copy]")) {
  const source = document.getElementById(button.dataset.copy);
  const status = button.parentElement.querySelector("[data-copy-status]");
  const idleLabel = button.textContent;

  button.hidden = false;
  button.addEventListener("click", async () => {
    let label = "copied";
    try {
      // The markup may break the command over lines; a shell wants one.
      const command = source.textContent.trim().replace(/\s+/g, " ");
      await navigator.clipboard.writeText(command);
    } catch {
      // No clipboard access (an insecure origin, or the permission is denied):
      // select the command so the keyboard shortcut copies it.
      document.getSelection().selectAllChildren(source);
      label = "selected";
    }
    button.textContent = label;
    status.textContent =
      label === "copied" ? "Command copied." : "Command selected.";
    setTimeout(() => {
      button.textContent = idleLabel;
      status.textContent = "";
    }, RESET_AFTER_MS);
  });
}
