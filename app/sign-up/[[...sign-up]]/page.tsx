import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      {/* fallback, not force: an explicit ?redirect_url (Shopify install) wins. */}
      <SignUp fallbackRedirectUrl="/dashboard" />
    </main>
  );
}
