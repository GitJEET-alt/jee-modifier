# How to Run and Deploy JEE Modifier (Next.js)

Since your current machine does not have Node.js installed, I have created all the necessary files for your safe, backend-driven Next.js application in the `jee-modifier-next` folder. 

Here are the exact steps to get this running locally and on the web for free.

## Step 1: Install Node.js (If running locally)
1. Download and install [Node.js](https://nodejs.org/).
2. Open a terminal inside the `jee-modifier-next` folder.
3. Run `npm install` to download all the necessary packages (Next.js, NextAuth, Gemini SDK, etc.).

## Step 2: Configure Environment Variables
1. Rename the `.env.example` file to `.env.local`.
2. Open it and fill in the 4 required values:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `ALLOWED_EMAILS` (e.g. `yourname@company.com,other@company.com`)
   - `GEMINI_API_KEY` (Your paid Gemini API key).

## Step 3: Run Locally
1. In the terminal, run `npm run dev`.
2. Open your browser to `http://localhost:3000`.
3. *Important:* Make sure you add `http://localhost:3000/api/auth/callback/google` to your Google Cloud Console "Authorized redirect URIs".

---

## Step 4: Deploying to Vercel (For Free)

To share this with your team safely on the web, follow these steps:

1. **Upload to GitHub:**
   - Create a new Private repository on GitHub.
   - Upload the contents of the `jee-modifier-next` folder to that repository.
   - *Note: Your `.env.local` file is automatically ignored by Git, so your API key will NOT be uploaded to GitHub.*

2. **Connect to Vercel:**
   - Go to [Vercel.com](https://vercel.com/) and sign up with your GitHub account.
   - Click "Add New Project" and select the GitHub repository you just created.

3. **Add Vercel Environment Variables:**
   - In the Vercel deployment screen, expand the "Environment Variables" section.
   - You **MUST** add the exact same 4 variables from your `.env.local` file here so Vercel's backend can access them:
     - `GOOGLE_CLIENT_ID`
     - `GOOGLE_CLIENT_SECRET`
     - `ALLOWED_EMAILS`
     - `GEMINI_API_KEY`
     - `NEXTAUTH_URL` (Set this to your expected Vercel URL, e.g. `https://jee-modifier.vercel.app`)
     - `NEXTAUTH_SECRET` (A random string to encrypt the sessions)

4. **Deploy & Update Google Cloud:**
   - Click "Deploy". Within a minute, you will get a live URL (e.g., `https://jee-modifier.vercel.app`).
   - Finally, copy that live URL and add `https://jee-modifier.vercel.app/api/auth/callback/google` to your Google Cloud Console "Authorized redirect URIs".

Now, you can send that URL to your teammates. The public will be blocked by the Google Login, and only authorized emails will be let in. Your Gemini API key is safely hidden inside Vercel's encrypted backend!
