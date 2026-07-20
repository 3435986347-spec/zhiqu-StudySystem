-- Repair knowledge pages orphaned by deletes performed before child reparenting was introduced.
UPDATE user_knowledge_page child
LEFT JOIN user_knowledge_page parent
  ON parent.id = child.parent_id
 AND parent.user_id = child.user_id
 AND parent.deleted = 0
SET child.parent_id = NULL,
    child.version = child.version + 1,
    child.updated_at = CURRENT_TIMESTAMP
WHERE child.deleted = 0
  AND child.parent_id IS NOT NULL
  AND parent.id IS NULL;

-- Old clients could resolve revisions individually. A package containing both approved and
-- rejected children is terminally partial; any unresolved children are rejected during upgrade.
UPDATE user_knowledge_revision revision
JOIN (
  SELECT patch_set_id
  FROM user_knowledge_revision
  WHERE patch_set_id IS NOT NULL AND deleted = 0
  GROUP BY patch_set_id
  HAVING SUM(status = 'APPROVED') > 0 AND SUM(status = 'REJECTED') > 0
) mixed ON mixed.patch_set_id = revision.patch_set_id
SET revision.status = 'REJECTED'
WHERE revision.deleted = 0 AND revision.status = 'PENDING';

UPDATE knowledge_patch_set patch_set
JOIN (
  SELECT patch_set_id
  FROM user_knowledge_revision
  WHERE patch_set_id IS NOT NULL AND deleted = 0
  GROUP BY patch_set_id
  HAVING SUM(status = 'APPROVED') > 0 AND SUM(status = 'REJECTED') > 0
) mixed ON mixed.patch_set_id = patch_set.id
SET patch_set.status = 'PARTIAL',
    patch_set.updated_at = CURRENT_TIMESTAMP
WHERE patch_set.deleted = 0;
