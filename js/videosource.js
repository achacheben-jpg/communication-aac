// ═══════════════════════════════════════════
// VIDEO SOURCE — fichier vidéo chargé localement
// ═══════════════════════════════════════════
// Sert quand l'utilisateur veut tester l'app sur une vidéo pré-enregistrée
// (plutôt que sur un flux live getUserMedia).
window.VideoSource = (function() {
  let fileURL = null;
  let fileName = '';
  let transcript = '';
  let startTime = 0;

  function set(file) {
    clear();
    fileURL = URL.createObjectURL(file);
    fileName = file.name || 'vidéo';
    transcript = '';
    startTime = Date.now();
  }

  function clear() {
    if (fileURL) {
      try { URL.revokeObjectURL(fileURL); } catch (e) {}
    }
    fileURL = null;
    fileName = '';
  }

  function has() { return !!fileURL; }
  function url() { return fileURL; }
  function name() { return fileName; }

  function resetTranscript() {
    transcript = '';
    startTime = Date.now();
  }

  function appendSelection(val) {
    transcript += val;
  }

  function getTranscript() { return transcript; }

  return { set, clear, has, url, name, resetTranscript, appendSelection, getTranscript };
})();
