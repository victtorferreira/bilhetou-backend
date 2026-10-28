import { randomInt, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';

export interface GeneratedTicket { id: string; serial: string; numbers: string[] }
export interface GenerationInput { quantity: number; prefix: string; uniqueNumbers: boolean }
export interface StockEntry { serial: string; numbers: { value: string }[] }

export function generateTickets(input: GenerationInput, stock: StockEntry[], choose = randomInt): GeneratedTicket[] {
  const prefix = input.prefix.trim().toUpperCase();
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 2500) throw new BadRequestException('Quantidade deve ser um inteiro entre 1 e 2.500.');
  if (!/^[A-Z][A-Z0-9-]{0,11}$/.test(prefix)) throw new BadRequestException('Prefixo inválido. Use até 12 letras, números ou hífens, começando com uma letra.');
  if (stock.length + input.quantity > 2500) throw new ConflictException('O estoque aceita até 2.500 bilhetes por campanha.');
  const occupied = new Set(stock.flatMap(ticket => ticket.numbers.map(number => number.value)));
  const pool = Array.from({ length: 10000 }, (_, i) => String(i).padStart(4, '0')).filter(number => !occupied.has(number));
  if (input.quantity * 4 > pool.length) throw new ConflictException(`Há números inéditos para apenas ${Math.floor(pool.length / 4)} bilhete(s).`);
  let sequence = 0;
  for (const ticket of stock) {
    if (!ticket.serial.startsWith(`${prefix}-`)) continue;
    const suffix = ticket.serial.slice(prefix.length + 1);
    if (/^\d{6}$/.test(suffix)) sequence = Math.max(sequence, Number(suffix));
  }
  if (sequence + input.quantity > 999999) throw new ConflictException('Limite de seriais atingido. Escolha outro prefixo.');
  return Array.from({ length: input.quantity }, () => {
    const numbers: string[] = [];
    for (let j = 0; j < 4; j++) {
      const index = choose(pool.length);
      numbers.push(pool[index]);
      pool[index] = pool[pool.length - 1];
      pool.pop();
    }
    return { id: randomUUID(), serial: `${prefix}-${String(++sequence).padStart(6, '0')}`, numbers };
  });
}
