import { redirect } from "next/navigation";

export default async function Page({ params }: { params: Promise<{ phone: string }> }) {
  const { phone } = await params;
  redirect(`/?phone=${encodeURIComponent(phone)}`);
}
