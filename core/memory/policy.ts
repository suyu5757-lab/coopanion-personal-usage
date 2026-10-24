const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /\b(?:password|passwd|passcode|api[_-]?key|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi,
  /\b(?:\d[ -]?){13,19}\b/g,
];

const SENSITIVE = /(?:密码|口令|验证码|银行卡号|信用卡号|身份证号|私钥|助记词|种子短语|password\s*[:=]|passcode\s*[:=]|api[_-]?key\s*[:=]|secret\s*[:=]|access[_-]?token\s*[:=]|refresh[_-]?token\s*[:=]|(?:token|secret|password|passwd|passcode)\s*[:=]\s*[A-Za-z0-9._~+/=-]{12,}|credit card number|social security number|seed phrase|private key)/i;

export interface MemorySafeText {
  text: string;
  skip?: 'sensitive';
}

export function sanitizeForMemory(text: string): MemorySafeText {
  const body = text.trim();
  if (!body) return { text: '' };
  if (SENSITIVE.test(body)) return { text: '', skip: 'sensitive' };
  let out = body;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return { text: out };
}
