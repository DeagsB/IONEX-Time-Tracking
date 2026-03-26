# Step-by-Step: Push IONEX Time Tracking to GitHub

## Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Repository name: `ionex-time-tracking` (or your preferred name)
3. Description: "IONEX Time Tracking Software - Supabase + Vercel"
4. Choose: **Public** or **Private**
5. **DO NOT** check any boxes (no README, .gitignore, or license)
6. Click **"Create repository"**
7. Copy the repository URL (e.g., `https://github.com/YOUR_USERNAME/ionex-time-tracking.git`)

## Step 2: Open Terminal in Project Folder

Open PowerShell or Command Prompt and navigate to:
```
C:\Users\FPCR\Desktop\IONEX Time Tracking Software\IONEX Time Tracking Software
```

## Step 3: Run Git Commands

Copy and paste these commands one by one (replace the repo URL with yours):

```bash
# Initialize git
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit - IONEX Time Tracking with Supabase integration"

# Set main branch
git branch -M main

# Add remote (REPLACE WITH YOUR REPO URL)
git remote add origin https://github.com/YOUR_USERNAME/ionex-time-tracking.git

# Push to GitHub
git push -u origin main
```

## Step 4: If prompted for credentials

- **Username**: Your GitHub username
- **Password**: Use a Personal Access Token (not your password)
  - Generate one at: https://github.com/settings/tokens
  - Select scope: `repo` (full control of private repositories)

## Troubleshooting

### If "git is not recognized"
- Close and reopen your terminal
- Or restart your computer
- Verify Git is in PATH: Open Git Bash and run `git --version`

### If authentication fails
- Use Personal Access Token instead of password
- Or use SSH keys: https://docs.github.com/en/authentication/connecting-to-github-with-ssh


