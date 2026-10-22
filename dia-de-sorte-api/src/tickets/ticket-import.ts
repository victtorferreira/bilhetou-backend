export interface ImportRow { serial: string; numbers: string[]; line?: number }
export interface ImportIssue { line: number; serial: string; reasons: string[]; duplicateNumbers: string[] }
export function validateImport(rows: ImportRow[], stock: { serial: string; numbers: { value: string }[] }[]) {
  const serials = new Set(stock.map(t => t.serial));
  const owners = new Map(stock.flatMap(t => t.numbers.map(n => [n.value, t.serial] as const)));
  const seenSerials = new Set<string>();
  const seenNumbers = new Map<string, number>();
  const valid: ImportRow[] = [];
  const errors: ImportIssue[] = [];
  rows.forEach((row, index) => {
    const line = row.line ?? index + 2;
    const reasons: string[] = [];
    const duplicateNumbers: string[] = [];
    if (!/^[A-Z0-9-]{1,40}$/.test(row.serial)) reasons.push('Serial inválido (use letras maiúsculas, números e hífen).');
    if (serials.has(row.serial) || seenSerials.has(row.serial)) reasons.push('Serial duplicado.');
    seenSerials.add(row.serial);
    if (row.numbers.length !== 4 || row.numbers.some(n => !/^[0-9]{4}$/.test(n))) reasons.push('Informe exatamente quatro números com quatro dígitos.');
    const local = new Set<string>();
    for (const number of row.numbers) {
      if (local.has(number)) { reasons.push(`Número ${number} repetido no bilhete.`); duplicateNumbers.push(number); }
      else if (owners.has(number)) { reasons.push(`O número ${number} da linha ${line} já pertence ao bilhete ${owners.get(number)} nesta campanha.`); duplicateNumbers.push(number); }
      else if (seenNumbers.has(number)) { reasons.push(`O número ${number} já aparece na linha ${seenNumbers.get(number)} do arquivo.`); duplicateNumbers.push(number); }
      local.add(number);
      if (!seenNumbers.has(number)) seenNumbers.set(number, line);
    }
    if (!reasons.length && stock.length + valid.length >= 2500) reasons.push('Limite de 2.500 bilhetes por campanha.');
    if (reasons.length) errors.push({ line, serial: row.serial, reasons, duplicateNumbers: [...new Set(duplicateNumbers)] });
    else valid.push(row);
  });
  return { valid, errors, total: rows.length, rejected: errors.length, duplicateNumbers: [...new Set(errors.flatMap(e => e.duplicateNumbers))] };
}
