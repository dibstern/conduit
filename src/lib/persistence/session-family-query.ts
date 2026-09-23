// Restrict row lookups to family IDs before sorting; an ordered join can scan
// the entire sessions updated_at index for each viewed family.
export const sessionFamilyQuery = `WITH RECURSIVE ancestors(id, parent_id) AS (
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
)
SELECT s.* FROM sessions s WHERE s.id IN (SELECT id FROM family)
ORDER BY s.updated_at DESC, s.id DESC`;
