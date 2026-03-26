# Revert reference

**Production commit before migration:** `9de5c34`  
**Message:** Fix TS2339: add user to employee type cast in Invoices standalone ticket

Use this commit to revert both code and database if the full migration (approver_po_afe → approver, po_afe, cc) causes issues.

```bash
git revert --no-commit <newer-commits>..HEAD
# or
git reset --hard 9de5c34
```

Database: restore from backup taken before migration (see MIGRATION-REMOVAL-NOTE.md step 0).
