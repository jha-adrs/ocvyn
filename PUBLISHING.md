# Publishing OCVYN

Extension id: **`platinumj.ocvyn`** · Repo: **https://github.com/jha-adrs/ocvyn** · License: MIT

Do the steps in order. Push to GitHub before publishing: the store page loads its screenshots from the repo.

## 0. Before you start

- [ ] **Name check (manual).** An automated search found no clash for "OCVYN" on the VS Code Marketplace, Open VSX, npm, GitHub or Trademarkia (8 Oct 2026). The official trademark databases couldn't be reached from the server. Check them in a browser:
  - USPTO: https://tmsearch.uspto.gov
  - EU / national: https://www.tmdn.org/tmview
  - WIPO: https://branddb.wipo.int
- [ ] **Your employer.** If your employment contract covers software you write, check it allows you to publish this personally.
- [ ] **Git identity.** This repo commits as `jha-adrs <jha-adrs@users.noreply.github.com>` (set in `.git/config`, not globally).
  - To use your GitHub "private email" address instead, copy it from https://github.com/settings/emails, then run `git config user.email "<it>"` and `git commit --amend --reset-author --no-edit`.

## 1. Push the code to GitHub (as jha-adrs)

The server is logged into GitHub as a different account (`aadarsh-jha`). Add `jha-adrs` and use it for this repo only:

```sh
gh auth login              # choose GitHub.com → HTTPS → log in as jha-adrs
gh auth switch -u jha-adrs # make it the active account
gh auth status             # check: "Active account: true" next to jha-adrs

gh repo create jha-adrs/ocvyn --public --source . --remote origin \
  --description "Fast read-only grid for large CSV, TSV and spreadsheet files in VS Code"
git push -u origin main
gh repo edit jha-adrs/ocvyn \
  --add-topic vscode-extension --add-topic csv --add-topic tsv --add-topic csv-viewer \
  --add-topic xlsx --add-topic spreadsheet --add-topic data-viewer --add-topic vscode

gh auth switch -u aadarsh-jha   # switch back afterwards
```

- [ ] Open the repo page and check the three images in `media/` show.
- [ ] Settings → Code security → turn on **Private vulnerability reporting** (`SECURITY.md` points there).

## 2. Visual Studio Marketplace

1. [ ] Sign in at https://marketplace.visualstudio.com/manage and create the publisher **`platinumj`**. The id can't be changed later.
2. [ ] Get a token. Go to https://dev.azure.com → User settings → Personal access tokens → New token:
   - Organization: **All accessible organizations**
   - Scopes: **Marketplace → Manage**
   - **Deadline:** Microsoft retires this kind of token on **1 Dec 2026**. After that, publish with Microsoft Entra ID instead (`vsce publish --azure-credential`); see https://code.visualstudio.com/api/working-with-extensions/publishing-extension.
3. [ ] Publish:
   ```sh
   npx vsce login platinumj     # paste the token
   npm test
   npx vsce publish             # builds, packages and uploads
   ```
   Or upload `ocvyn-<version>.vsix` by hand on the manage page.
4. [ ] Wait a few minutes for the scan, then open https://marketplace.visualstudio.com/items?itemName=platinumj.ocvyn and check the page.

## 3. Open VSX (Cursor, VSCodium, Windsurf)

1. [ ] Log in at https://open-vsx.org with the **jha-adrs** GitHub account.
2. [ ] Link an Eclipse Foundation account (its GitHub username must be `jha-adrs`), then accept the **Open VSX Publisher Agreement** from your profile page.
3. [ ] Create an access token on your Open VSX profile, then run:
   ```sh
   npx ovsx create-namespace platinumj -p <token>
   npx ovsx publish ocvyn-<version>.vsix -p <token>
   ```
4. [ ] Claim the `platinumj` namespace, to remove the "unverified publisher" warning: https://github.com/EclipseFdn/open-vsx.org/wiki/Namespace-Access

## Releasing an update

1. Add the changes to `CHANGELOG.md`.
2. Bump the version, push, then publish:
   ```sh
   npx vsce publish patch          # or minor; bumps package.json, commits, tags and uploads
   git push --follow-tags
   npx ovsx publish -p <token>
   ```

## Notes on names and trademarks

- **Microsoft names.** Keep "Excel", "VS Code" and "Visual Studio" out of the extension's **name**. Using them to describe what it works with ("opens .xlsx files", "in VS Code") is fine.
- **Other extensions.** Don't use other extensions' names (e.g. Rainbow CSV) or icons in the listing.
- **SheetJS.** `THIRD_PARTY_NOTICES.md` must stay in the package. `.vscodeignore` already includes it.
