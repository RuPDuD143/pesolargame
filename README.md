Commands to use whenever you edit index.html
After saving your changes, open the Codespaces terminal and run:
//
git add index.html
git commit -m "Update game page"
git push origin main
//
That's it. GitHub Actions will take care of the Firebase deployment.

How to check if it deployed:
1. Open your GitHub repository: RuPDuD143/pesolargame.
2. Click the Actions tab.
3. Open the latest Deploy to Firebase Hosting run.
4. Wait for it to finish successfully.
5. Refresh https://pesolargame.web.app.

Automatic deployment enabled
A few things to remember:
- Only pushes to main trigger the workflow we configured.
- If you edit multiple files, remember to add those files too. You can use git add . to include all changes.
- If deployment fails, your previous live version should remain available until a successful deployment.
