export function TransactionList({ transactions }: { transactions: Array<{ id: string }> }) {
  if (transactions.length === 0) return null;
  return <ul>{transactions.map((transaction) => <li key={transaction.id}>{transaction.id}</li>)}</ul>;
}
