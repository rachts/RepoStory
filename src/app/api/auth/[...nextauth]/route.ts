import NextAuth, { type AuthOptions } from "next-auth";
import GithubProvider from "next-auth/providers/github";

export const authOptions: AuthOptions = {
  providers: [
    GithubProvider({
      // In production, real GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are provided.
      // Fallback mock credentials allow offline tests and local development without GitHub OAuth configured.
      clientId: process.env.GITHUB_CLIENT_ID ?? "mock-client-id",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "mock-client-secret",
      authorization: {
        params: {
          scope: "read:user user:email repo",
        },
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async session({ session, token }) {
      if (token?.sub && session.user) {
        (session.user as { id?: string }).id = token.sub;
      }
      if (token?.accessToken) {
        (session as { accessToken?: string }).accessToken = token.accessToken as string;
      }
      return session;
    },
    async jwt({ token, user, account }) {
      if (user) {
        token.sub = user.id;
      }
      if (account?.access_token) {
        token.accessToken = account.access_token;
      }
      return token;
    },
  },
  secret: process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "repo-story-secret-key-32-chars-minimum-needed",
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
