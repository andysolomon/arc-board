import { TransactionList } from '../../components/TransactionList';

export default function DashboardPage() {
  const transactions = [];
  return <TransactionList transactions={transactions} />;
}
