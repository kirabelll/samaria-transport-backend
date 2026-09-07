import prisma from './prisma';
import { generateJournalEntryNumber } from './sequence-generator';

/**
 * Automatically post a double-entry journal entry based on AccountingConfig mappings.
 * Looks up the debit/credit accounts from config, creates JournalEntry + 2 lines,
 * and updates Account balances atomically.
 *
 * Returns null silently if no active config exists for the transaction type
 * (allows gradual rollout — only posts when mappings are configured).
 */
export async function postJournalEntry(params: {
  sourceType: string;    // matches AccountingConfig.transactionType
  sourceId: string;      // ID of the source entity (trip, fuel log, etc.)
  amount: number;
  description: string;
  reference?: string;    // e.g. trip number, transfer number
  date?: Date;
  createdBy?: string;
}): Promise<any | null> {
  const { sourceType, sourceId, amount, description, reference, date, createdBy } = params;

  if (!amount || amount <= 0) return null;

  // Look up accounting config for this transaction type
  const config = await prisma.accountingConfig.findUnique({
    where: { transactionType: sourceType },
  });
  if (!config || !config.isActive) return null;

  // Verify both accounts exist
  const [debitAccount, creditAccount] = await Promise.all([
    prisma.account.findUnique({ where: { id: config.debitAccountId } }),
    prisma.account.findUnique({ where: { id: config.creditAccountId } }),
  ]);
  if (!debitAccount || !creditAccount) return null;

  // Check for duplicate — don't double-post for same source
  const existing = await prisma.journalEntry.findFirst({
    where: { sourceType, sourceId, source: 'auto' },
  });
  if (existing) return existing;

  // Generate entry number
  const entryNumber = await generateJournalEntryNumber();

  // Create journal entry with lines and update balances atomically
  const entry = await prisma.$transaction(async (tx: any) => {
    const je = await tx.journalEntry.create({
      data: {
        entryNumber,
        date: date || new Date(),
        description,
        reference: reference || null,
        source: 'auto',
        sourceType,
        sourceId,
        status: 'posted',
        totalAmount: amount,
        createdBy: createdBy || 'system',
        lines: {
          create: [
            {
              accountId: config.debitAccountId,
              description: `${config.description || sourceType} - DR`,
              debit: amount,
              credit: 0,
            },
            {
              accountId: config.creditAccountId,
              description: `${config.description || sourceType} - CR`,
              debit: 0,
              credit: amount,
            },
          ],
        },
      },
      include: { lines: true },
    });

    // Update account balances
    // Debit increases asset/expense, decreases liability/equity/revenue
    await tx.account.update({
      where: { id: config.debitAccountId },
      data: { balance: { increment: amount } },
    });
    // Credit decreases asset/expense, increases liability/equity/revenue
    await tx.account.update({
      where: { id: config.creditAccountId },
      data: { balance: { decrement: amount } },
    });

    return je;
  });

  return entry;
}

/**
 * Reverse a previously auto-posted journal entry.
 * Creates a new reversing entry with opposite debits/credits.
 */
export async function reverseJournalEntry(sourceType: string, sourceId: string, reason?: string): Promise<any | null> {
  const original = await prisma.journalEntry.findFirst({
    where: { sourceType, sourceId, source: 'auto', status: 'posted' },
    include: { lines: true },
  });
  if (!original) return null;

  const entryNumber = await generateJournalEntryNumber();

  const entry = await prisma.$transaction(async (tx: any) => {
    // Mark original as reversed
    await tx.journalEntry.update({
      where: { id: original.id },
      data: { status: 'reversed' },
    });

    // Create reversing entry (swap debits and credits)
    const je = await tx.journalEntry.create({
      data: {
        entryNumber,
        date: new Date(),
        description: `Reversal: ${original.description}${reason ? ` (${reason})` : ''}`,
        reference: original.entryNumber,
        source: 'auto',
        sourceType: sourceType + '_reversal',
        sourceId,
        status: 'posted',
        totalAmount: original.totalAmount,
        createdBy: 'system',
        lines: {
          create: original.lines.map((l: any) => ({
            accountId: l.accountId,
            description: `Reversal: ${l.description}`,
            debit: l.credit,   // swap
            credit: l.debit,   // swap
          })),
        },
      },
    });

    // Reverse account balance updates
    for (const line of original.lines) {
      await tx.account.update({
        where: { id: line.accountId },
        data: { balance: { increment: (line.credit || 0) - (line.debit || 0) } },
      });
    }

    return je;
  });

  return entry;
}
