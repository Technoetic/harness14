# Reviewed requirement coverage

Freeze a reviewed list of requirement IDs, acceptance IDs and mandatory QA check IDs before implementation. This control proves coverage of that declared list; it cannot infer missing intent from natural-language prose. Review the inventory against the approved TOPIC first. Correct an incorrect inventory through a new reviewed workflow generation, rather than weakening the frozen mapping.

Input schema 1 contains exactly these fields:

```json
{
  "schema_version": 1,
  "requirements": [{ "id": "R-navigation", "acceptance_ids": ["AC-navigation"] }],
  "acceptance": [{ "id": "AC-navigation", "check_ids": ["navigation"] }]
}
```

Every requirement and acceptance item needs at least one explicit reference. All acceptance IDs must be known and referenced by a requirement. IDs and references are case-sensitive; case-folded duplicates are rejected. A check ID belongs to one acceptance item. Empty arrays, optional fields, unknown fields and credential-shaped identifiers are rejected. Inventories permit up to 64 requirements, 64 acceptance items and 64 mandatory check IDs within a 64 KiB UTF-8 JSON bound. JSON with duplicate keys is rejected at the CLI and when reading stored files.

The existing final QA snapshot permits 64 total distinct checks, including its six mandatory regression checks. Keep the combined union within that limit: if none of the mapped product checks overlaps those six, at most 58 distinct product-only checks fit. Multiple reviewed requirements may share an acceptance item; preserve their obligations when choosing the mapping.

```powershell
Get-Content -Raw reviewed-requirements.json | node scripts/requirement-coverage.mjs freeze --workspace . --input -
node scripts/requirement-coverage.mjs inspect-inventory --workspace . --inventory-sha256 <returned-sha256>
node scripts/requirement-coverage.mjs inspect --workspace . --inventory-sha256 <returned-sha256>
```

All commands accept an optional `--workflow-profile` that must agree with existing workflow metadata. Inspectors require the expected SHA256 returned by freeze to pass. The same expected hash belongs in quality configuration schema 2. Missing or changed inventory, absent expected hash and invalid bindings produce `INCOMPLETE`.

The library exports `freezeRequirements(workspaceRoot,input,options={})`, `inspectRequirementInventory(workspaceRoot,options={})` and `inspectRequirementCoverage(workspaceRoot,options={})`. Options support `inventorySha256`, `workflowProfile` and the existing QA `pathPolicy` callback. Freeze returns the hash and sanitized counts. Inspectors return sanitized counts, IDs and PASS/INCOMPLETE statuses, without artifact paths, observations or raw QA reports. Rejected freeze calls throw a generic error; inspector failures return incomplete metadata. CLI exit code is 0 for PASS and 2 otherwise; invalid commands/input return a generic diagnostic on stderr.

The inventory is stored under `step_archive/outputs/requirement-coverage/<profile>/<generation>/` for active nonlegacy workflows. Legacy workspaces use the base directory. Both the claim and original-byte, content-addressed inventory are created exclusively with `wx`; another freeze cannot overwrite either. Files and parents must be physical, unaliased paths. The inventory binds the profile, workflow generation and exact TOPIC bytes when present, including the absence of TOPIC in isolated legacy fixtures. A crash after the immutable claim is created may leave incomplete evidence; it does not authorize replacing that claim.

Coverage inspects the profile's final QA step with the existing `inspectQa` safety checks. Every mandatory check must have a recorded PASS, evidence, unchanged current candidate artifacts and an independent verifier. Missing, failed, unverified, renamed or stale checks remain incomplete. Earlier QA steps and same-agent final QA do not satisfy this gate. Inventory and scope are rechecked after host path-policy callbacks. Inspection only reads evidence; it does not execute tests or commands.

MoAI's advisory requirement coverage inspired this control. Harness14 adds an explicitly reviewed immutable inventory, original-byte hashes, generation/TOPIC binding and shared final completion enforcement. Quality thresholds and the existing step topology retain their authority.
