import { initAll } from 'govuk-frontend'

initAll()

// When the server marks the page for auto-submit, the script presses the
// page's button. The user then does not need to click. Without JavaScript,
// the user presses the same button.
const $autoSubmit = /** @type {HTMLButtonElement | null} */ (
  document.querySelector('[data-module="app-auto-submit"] button')
)
$autoSubmit?.click()
