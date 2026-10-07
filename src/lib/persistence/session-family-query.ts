// The family of the session bound to `?`: its root (the topmost ancestor still
// present) and every descendant of that root, as the `family(id)` CTE.
const sessionFamilyCte = `WITH RECURSIVE ancestors(id, parent_id) AS (
	SELECT id, parent_id FROM sessions WHERE id = ?
	UNION
	SELECT s.id, s.parent_id FROM sessions s
	JOIN ancestors a ON s.id = a.parent_id
), family(id) AS (
	SELECT a.id FROM ancestors a
	WHERE a.parent_id IS NULL
		OR NOT EXISTS (SELECT 1 FROM sessions p WHERE p.id = a.parent_id)
	UNION
	SELECT s.id FROM sessions s JOIN family f ON s.parent_id = f.id
)`;

// The family's rows that moved inside a version window (`?` family member,
// `?` floor, `?` ceiling). A member moves when any session in its subtree does,
// because a row's summary aggregates its descendants (processing, questions,
// unread), as the shell's root read does for roots.
export const sessionFamilyWindowQuery = `${sessionFamilyCte}, subtree(member_id, id, version) AS (
	SELECT s.id, s.id, s.version FROM sessions s WHERE s.id IN (SELECT id FROM family)
	UNION
	SELECT t.member_id, c.id, c.version FROM sessions c JOIN subtree t ON c.parent_id = t.id
), members(member_id, effective_version) AS (
	SELECT member_id, MAX(version) FROM subtree GROUP BY member_id
)
SELECT s.*, m.effective_version FROM sessions s
JOIN members m ON m.member_id = s.id
WHERE m.effective_version > ? AND m.effective_version <= ?
ORDER BY s.updated_at DESC, s.id DESC`;
