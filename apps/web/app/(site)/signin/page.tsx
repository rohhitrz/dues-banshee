import { signInDemo } from "./actions";
import styles from "./signin.module.css";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Dues Banshee</h1>
      <form action={signInDemo} className={styles.form}>
        <button type="submit" className={styles.button}>
          Enter the graveyard (demo)
        </button>
      </form>
      {error ? (
        <p role="alert" className={styles.error}>
          Demo data is not seeded
        </p>
      ) : null}
    </main>
  );
}
