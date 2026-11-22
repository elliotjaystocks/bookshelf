# Bookshelf

A personal reading tracker. Books are stored in `books.md` in this repository and synced automatically via the GitHub API whenever you add, move, or remove a book in the app.

---

## First-time setup

### 1. Create a GitHub repository

1. Open [github.com](https://github.com) and sign in.
2. Click the **+** icon → **New repository**.
3. Name it `bookshelf` (or anything you like).
4. Leave it **Public** (required for a free GitHub Pages site).
5. Do **not** tick "Add a README" — you'll push these files yourself.
6. Click **Create repository**.

### 2. Add the app files to the repository

1. Open **GitHub Desktop**.
2. Go to **File → Clone Repository**, find your new `bookshelf` repo, and clone it to your computer.
3. Open the cloned folder in Finder / File Explorer.
4. Copy all the files from this folder into it:
   ```
   index.html
   to-read.html
   archive.html
   book.html
   books.md
   css/
   js/
   ```
5. Back in GitHub Desktop, you'll see all the new files listed.
6. Write a commit message (e.g. "Initial commit") and click **Commit to main**.
7. Click **Push origin**.

### 3. Enable GitHub Pages

1. On GitHub, go to your repository → **Settings** → **Pages**.
2. Under **Source**, choose **Deploy from a branch**.
3. Set the branch to `main` and the folder to `/ (root)`.
4. Click **Save**.
5. After a minute or two, GitHub will show you a URL like `https://your-username.github.io/bookshelf/`. That's your app.

### 4. Create a Personal Access Token

The app needs a token so it can write to `books.md` on your behalf.

1. Go to [GitHub → Settings → Developer settings → Fine-grained tokens](https://github.com/settings/tokens?type=beta).
2. Click **Generate new token**.
3. Give it a name: `Bookshelf`.
4. Set an expiration (one year is convenient).
5. Under **Repository access**, choose **Only select repositories** and pick your `bookshelf` repo.
6. Under **Permissions → Repository permissions**, set **Contents** to **Read and write**.
7. Click **Generate token**.
8. **Copy the token immediately** — GitHub won't show it again.

### 5. Connect the app to GitHub

1. Open your app in the browser (use the GitHub Pages URL from step 3).
2. Click the **settings** (gear) icon in the top bar. Until you connect, the app shows a read-only view of your shelf — which is also what everyone else sees.
3. Enter your **GitHub username**, **repository name** (`bookshelf`), and the **token** you just copied.
4. Click **Save & connect**. The app will verify your credentials and create `books.md` in the repo.
5. You're ready to start adding books.

---

## Pointing a custom domain

1. Go to your repo → **Settings → Pages → Custom domain**.
2. Enter your domain (e.g. `books.yourdomain.com`) and click **Save**.
3. In your DNS provider, add a **CNAME** record:
   - **Name:** `books` (or whatever subdomain you chose)
   - **Value:** `your-username.github.io`
4. Wait for DNS to propagate (usually a few minutes, sometimes up to an hour).
5. Tick **Enforce HTTPS** once it becomes available.

---

## How the database works

All your books live in `books.md` at the root of this repository. It's plain Markdown — you can open and edit it in any text editor. The format is:

```markdown
# Bookshelf

## currently-reading

### The Name of the Wind
- id: 1705123456789
- author: Patrick Rothfuss
- cover: https://covers.openlibrary.org/b/isbn/9780756404741-M.jpg
- isbn: 9780756404741

## to-read-bought

## to-read-someday

## archive-finished

## archive-abandoned
```

When you're connected, each book's page has **Move book** and **Edit details** buttons. Editing lets you fix the title or author, set the dates you started and finished it, and upload a new cover (resized automatically and saved to `covers/`). The app also fills in those dates for you: a book gets a `started` date when it moves to *Currently reading*, and a `finished` or `abandoned` date when it moves to the archive.

If you edit `books.md` manually, push the change via GitHub Desktop and reload the app; it checks GitHub for changes on every page load. You can add your own fields to a book (e.g. `- notes: …` or `- finished: 2026-11-01`) and the app will keep them when it saves.

---

## Security note

Your personal access token is stored in your **browser's localStorage** on the device you use to access the app. It never leaves your browser except to make requests directly to the GitHub API over HTTPS. The token is scoped to this one repository and can only read/write file contents — it cannot access anything else on your account.

If you ever need to revoke it, go to **GitHub → Settings → Developer settings → Fine-grained tokens** and delete the `Bookshelf` token.
