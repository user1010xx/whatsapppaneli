(function initWpHelpers(global) {
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]);
  }

  function normalizeSearchQuery(value) {
    return String(value || '').trim().toLocaleLowerCase('tr-TR');
  }

  function validatePassword(password) {
    const value = String(password || '');
    if (value.length < 8) {
      throw new Error('Şifre en az 8 karakter olmalıdır');
    }
    if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
      throw new Error('Şifre en az bir büyük harf, bir küçük harf ve bir rakam içermelidir');
    }
    return value;
  }

  global.WPHelpers = { escapeHtml, normalizeSearchQuery, validatePassword };
})(window);