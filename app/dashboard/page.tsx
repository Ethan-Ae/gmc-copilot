import { currentUser } from "@clerk/nextjs/server";

export default async function DashboardPage() {
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? "inconnu";

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6">
      <p className="tech-label text-muted">Connecté : {email}</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">Tableau de bord</h1>

      <section className="mt-8 rounded-lg border border-line bg-surface p-6">
        <h2 className="tech-label text-brand">Boutiques connectées</h2>
        <p className="mt-2 text-muted">À venir.</p>
      </section>
    </main>
  );
}
