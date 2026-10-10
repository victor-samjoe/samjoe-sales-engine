export function normalizeBrazilianPhone(input: string): string {
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('55')) digits = digits.slice(2);

  if (digits.length !== 10 && digits.length !== 11) {
    throw new Error('Telefone brasileiro deve conter DDD e 8 ou 9 dígitos');
  }

  const areaCode = Number(digits.slice(0, 2));
  if (areaCode < 11 || areaCode > 99 || digits.startsWith('0')) {
    throw new Error('DDD inválido');
  }

  return `+55${digits}`;
}

