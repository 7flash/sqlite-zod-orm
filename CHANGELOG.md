# Changelog

## Unreleased

### Fixed

- Rows with multiple foreign keys referencing the same table now load the correct related record for each key instead of mixing up related records.
- Lazy relationship navigation, eager loading with .with(), and cascade deletes now follow the specific foreign key associated with each relationship.
- Self-referencing relationships now distinguish forward navigation from inverse navigation, so parent and child lookups return the intended records.
- Schema migrations now preserve existing row IDs and column values while rebuilding tables, including their indexes, triggers, and foreign-key relationships.
- Tables with inline UNIQUE constraints can now be rebuilt with equivalent named unique indexes instead of requiring manual migration solely because of those constraints.
- Migration statements are finalized correctly, preventing pending prepared statements from blocking transaction completion.

### Changed

- Schema changes, including adding nullable or defaulted columns, now use transactional table reconstruction rather than ALTER TABLE ADD COLUMN. Affected tables retain versioned table_vN snapshots for recovery.
- Automatic migrations now refuse to change the type of a populated column or drop a populated column while adding another. These changes require explicit data migrations instead of silently copying incompatible data.
- Table rebuilds now stop when existing CHECK, NOT NULL, or ON CONFLICT constraints cannot be reconstructed without changing their behavior.
- Table rebuilds now refuse to silently change an existing foreign key's referenced table or ON DELETE/ON UPDATE actions.
- Automatic joins now throw an error when multiple foreign keys could connect the selected tables. Applications must specify the intended foreign key, for example .join('agents', 'authorRef', ['name']).
- When multiple foreign keys connect a child table to the same parent, inverse relationship accessors now use the names <childTable>By<FK>. For example, agents.grantsByAuthorRef() replaces ambiguous inverse navigation. Single-foreign-key inverse names remain unchanged.
- Relationship accessor names now avoid collisions with stored fields and entity methods by appending Relation where needed. Conflicting forward accessor names that cannot be resolved are rejected.
- Published TypeScript declarations now resolve from dist/ instead of package source files. Consumers receive declarations generated and checked during the package build.
- The documented runtime dependency baseline is now Zod 4.6.7 or newer, with measure-fn 5.x.

### Added

- Table rebuilds now validate dependent triggers before committing. If a trigger references a removed or renamed column, initialization reports the broken trigger and rolls back the migration.
- Rebuild validation now detects foreign-key violations and invalid dependent views before committing schema changes.
- Multiple inverse relationships to the same parent now have distinct, consistently typed accessors for both lazy navigation and .with() eager loading.
- Schema migrations retain historical table snapshots that can be inspected or recovered through db.migrator().
