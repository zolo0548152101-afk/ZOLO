import { AdminConsole } from "@/components/AdminConsole";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const phone = Array.isArray(params.phone) ? params.phone[0] ?? "" : params.phone ?? "";
  return <AdminConsole openPhone={phone} />;
}
