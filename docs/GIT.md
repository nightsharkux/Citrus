# Git and GitHub

The default branch is `main`. The repository stores source code, tests, documentation, and deployment templates. Local settings, databases, keys, recordings, and backups stay outside Git.

## Authenticate on Windows

GitHub CLI can be installed with:

```powershell
winget install --id GitHub.cli --exact --source winget --scope user
```

Open a new PowerShell window after installation so that `gh` is on its PATH. Sign in through the browser:

```powershell
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
gh auth status
```

Approve the device login in your browser. The CLI handles credentials; do not put a token in a project file or paste one into chat.

## Set the commit author automatically

Inside this project, read your GitHub profile and configure an author for this repository only:

```powershell
$githubProfile = gh api user | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Sign in to GitHub CLI first.' }
$gitAuthorName = if ($githubProfile.name) { $githubProfile.name } else { $githubProfile.login }
git config --local user.name $gitAuthorName
git config --local user.email "$($githubProfile.id)+$($githubProfile.login)@users.noreply.github.com"
```

This uses GitHub's privacy-preserving commit email and leaves author settings for other projects alone. Check the address under GitHub Settings > Emails if your account uses a different noreply format.

## First push

After local commits exist, create a private repository and push the current branch:

```powershell
gh repo create CampusOS_One --private --source . --remote origin --push
```

Run this once, only if `origin` has not already been configured. If you already created a GitHub repository, connect its URL instead:

```powershell
git remote add origin https://github.com/YOUR_USERNAME/CampusOS_One.git
git push --set-upstream origin main
```

## Ongoing work

Agents follow the Git workflow in `AGENTS.md`: test completed changes, review the diff, commit the relevant files, and push to the branch's upstream. This applies while an agent is working on a task; it does not run a background service that commits files as you edit them.

For manual changes:

```powershell
git status
npm test
git diff
git add path/to/changed-file
git diff --cached
git commit -m "Describe the completed change"
git push
```

Keep separate changes in separate commits. If a push is rejected because GitHub has newer commits, fetch and review them before reconciling the branches. Do not force-push.

## Deploy from GitHub

GitHub stores the repository and can trigger deployment when you push. Citrus needs a continuously running Node.js process and persistent storage for SQLite, keys, and recordings. GitHub Pages cannot run this server.

Connect the private repository to your Node hosting service or a VPS deployment workflow. Set secrets on the host and keep `storage/` persistent across releases. A fresh clone contains no local users or database; transferring an existing instance requires a separate, secure copy of its complete storage folder.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the server, HTTPS, and backup setup. Automatic deployment requires configuring that host or workflow separately.
