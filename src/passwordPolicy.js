const MIN_PASSWORD_LENGTH = 8;

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD_LENGTH) {
    const error = new Error(`Şifre en az ${MIN_PASSWORD_LENGTH} karakter olmalıdır`);
    error.statusCode = 400;
    throw error;
  }
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    const error = new Error('Şifre en az bir büyük harf, bir küçük harf ve bir rakam içermelidir');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

module.exports = { MIN_PASSWORD_LENGTH, validatePassword };