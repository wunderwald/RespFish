for (const btn of document.querySelectorAll('[data-frontend]')) {
  btn.addEventListener('click', () => window.api.launcher.select(btn.dataset.frontend));
}
