import { getContestConfig } from '@/lib/contest-config';
import { Dashboard } from '@/components/Dashboard';

export default function Page() {
  const config = getContestConfig();
  return <Dashboard contestConfig={config} />;
}
