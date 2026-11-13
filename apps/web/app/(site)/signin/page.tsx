import { signInDemo } from "./actions";
import { signInErrorMessage } from "./messages";
import styles from "./signin.module.css";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const message = signInErrorMessage((await searchParams).error);
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Dues Banshee</h1>
        <form action={signInDemo} className={styles.form}>
          <button type="submit" className={styles.button}>
            Enter the graveyard (demo)
          </button>
        </form>
        {message === null ? null : (
          <p role="alert" className={styles.error}>
            {message}
          </p>
        )}
      </div>
    </main>
  );
}
