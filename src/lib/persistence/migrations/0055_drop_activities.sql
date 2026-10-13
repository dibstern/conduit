-- The activity projection has no readers; dropping it also drops its indexes.
DROP TABLE IF EXISTS activities;
DELETE FROM projector_cursors WHERE projector_name = 'activity';
