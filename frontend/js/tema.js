// Aplica el tema guardado (o el del sistema) antes de pintar la página.
(function () {
    var t = null;
    try { t = localStorage.getItem('achirana_tema'); } catch (e) { /* almacenamiento bloqueado */ }
    if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
})();
