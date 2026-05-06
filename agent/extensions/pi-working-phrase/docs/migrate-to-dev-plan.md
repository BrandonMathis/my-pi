# Migrate to `~/Dev` Plan

This plan moves `pi-working-phrase` out of `~/.pi/agent/extensions/` and installs it like a public Pi package, but from a local directory on this machine.

Goal location:

```txt
~/Dev/pi-working-phrase
```

Local package install source:

```txt
~/Dev/pi-working-phrase
```

## Safety goals

- Preserve the standalone extension git repository.
- Avoid loading the extension twice.
- Avoid accidentally committing the extension files into the parent `~/.pi` repository.
- Keep an easy rollback path until the local-package install is verified.

## 1. Inspect the current state

From anywhere:

```bash
git -C ~/.pi status --short -- agent/extensions/pi-working-phrase
git -C ~/.pi/agent/extensions/pi-working-phrase status --short
```

Expected notes:

- The first command shows what the parent `~/.pi` repo sees.
- The second command shows what the standalone extension repo sees.
- If the extension repo has important uncommitted work, commit it or leave the original directory untouched until the migration is verified.

## 2. Create the `~/Dev` destination

```bash
mkdir -p ~/Dev
```

## 3. Copy the extension to `~/Dev`

Use `rsync` so the original stays in place as a rollback source while verifying the install. Exclude `node_modules`; it can be recreated with `npm install`.

```bash
rsync -a \
  --exclude node_modules \
  ~/.pi/agent/extensions/pi-working-phrase/ \
  ~/Dev/pi-working-phrase/
```

Verify the standalone git repo came along:

```bash
git -C ~/Dev/pi-working-phrase status --short
git -C ~/Dev/pi-working-phrase branch --show-current
```

## 4. Install dependencies in the new location

```bash
cd ~/Dev/pi-working-phrase
npm install
```

Run the checks from the new location:

```bash
npm run format:check
npm run typecheck
npm test
npm run smoke:load
npm run pack:check
```

## 5. Prevent duplicate extension loading

Pi auto-discovers extensions under `~/.pi/agent/extensions/`. If the original directory remains there while the local package is also installed, Pi may load the extension twice.

Rename the original directory to a temporary backup outside the auto-discovery name:

```bash
mv ~/.pi/agent/extensions/pi-working-phrase \
  ~/.pi/agent/extensions/pi-working-phrase.backup-$(date +%Y%m%d-%H%M%S)
```

Do not delete this backup yet.

## 6. Install the local package with Pi

Install globally from the local directory:

```bash
pi install ~/Dev/pi-working-phrase
```

Verify Pi recorded the package:

```bash
pi list
```

You should see an entry pointing at `~/Dev/pi-working-phrase` or its expanded absolute path.

## 7. Reload and verify in Pi

Start or return to Pi and run:

```txt
/reload
```

Manual verification checklist:

- [ ] Pi reloads without extension errors.
- [ ] Sending a prompt shows the custom colored spinner.
- [ ] The first working phrase appears immediately.
- [ ] The shine animation moves.
- [ ] The phrase changes after the configured shuffle interval.
- [ ] The default working message and indicator return when the agent finishes.
- [ ] There are no duplicate working messages or duplicate-looking animations.

## 8. Clean up the parent `~/.pi` repository

Because this extension is now its own repo under `~/Dev`, the parent `~/.pi` repo should not track it as ordinary files.

From the parent repo:

```bash
cd ~/.pi
```

If the parent repo currently tracks extension files, untrack them without deleting the `~/Dev` copy:

```bash
git rm -r --cached agent/extensions/pi-working-phrase
```

If that path is already gone or untracked, the command may report no matches; that is okay.

Add ignores so future local backups are not accidentally tracked:

```bash
printf '\n# Standalone local extension repos/backups\nagent/extensions/pi-working-phrase/\nagent/extensions/pi-working-phrase.backup-*/\n' >> ~/.pi/.gitignore
```

Review the parent repo changes:

```bash
git status --short
```

Commit the parent repo cleanup only when ready.

## 9. Remove the temporary backup after verification

After the local package install works and you are confident there are no missing files, remove the backup created in step 5:

```bash
ls -d ~/.pi/agent/extensions/pi-working-phrase.backup-* 2>/dev/null
rm -rf ~/.pi/agent/extensions/pi-working-phrase.backup-YYYYMMDD-HHMMSS
```

Replace `YYYYMMDD-HHMMSS` with the actual backup suffix.

## Rollback plan

If the local package install does not work:

1. Remove the local package from Pi settings:

   ```bash
   pi remove ~/Dev/pi-working-phrase
   ```

   If `pi remove` expects the exact stored path, copy it from `pi list`.

2. Restore the auto-discovered extension directory:

   ```bash
   mv ~/.pi/agent/extensions/pi-working-phrase.backup-YYYYMMDD-HHMMSS \
     ~/.pi/agent/extensions/pi-working-phrase
   ```

3. Reload Pi:

   ```txt
   /reload
   ```

## Future GitHub release notes

When ready to publish:

```bash
cd ~/Dev/pi-working-phrase
git remote add origin git@github.com:brandonmathis/pi-working-phrase.git
git push -u origin main
```

After the GitHub repository exists, users can install with:

```bash
pi install git:github.com/brandonmathis/pi-working-phrase
```
