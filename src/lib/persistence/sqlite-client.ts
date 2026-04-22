// src/lib/persistence/sqlite-client.ts
import {
	DatabaseSync,
	type SQLInputValue,
	type StatementSync,
} from "node:sqlite";

/**
 * Thin wrapper around Node 22+ `node:sqlite` DatabaseSync.
 *
 * Provides:
 * - WAL mode by default for file-backed databases
 * - Prepared statement cache (LRU-evicted by capacity)
 * - Synchronous `runInTransaction()` with nested savepoint support
 * - Typed `query<T>()` and `queryOne<T>()` helpers
 */
export class SqliteClient {
	private readonly db: DatabaseSync;
	private readonly stmtCache = new Map<string, StatementSync>();
	private readonly maxCacheSize: number;
	private transactionDepth = 0;
	private savepointCounter = 0;

	private constructor(db: DatabaseSync, maxCacheSize: number) {
		this.db = db;
		this.maxCacheSize = maxCacheSize;
	}

	/**
	 * Open a file-backed database with WAL mode and recommended pragmas.
	 */
	static open(
		filename: string,
		opts?: { maxCacheSize?: number },
	): SqliteClient {
		const db = new DatabaseSync(filename);
		return SqliteClient.init(db, opts?.maxCacheSize ?? 200, true);
	}

	/**
	 * Open an in-memory database. Useful for testing.
	 */
	static memory(opts?: { maxCacheSize?: number }): SqliteClient {
		const db = new DatabaseSync(":memory:");
		return SqliteClient.init(db, opts?.maxCacheSize ?? 200, false);
	}

	private static init(
		db: DatabaseSync,
		maxCacheSize: number,
		isFileBacked: boolean,
	): SqliteClient {
		if (isFileBacked) {
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA synchronous = NORMAL");
			// (S6) Performance tuning for file-backed databases:
			// 64MB page cache — keeps hot indexes in memory for DBs up to ~2GB
			db.exec("PRAGMA cache_size = -65536");
			// ~16MB WAL before auto-checkpoint — reduces mid-burst checkpoint stalls
			db.exec("PRAGMA wal_autocheckpoint = 4000");
			// 256MB memory-mapped reads — reduces syscall overhead for large range scans
			db.exec("PRAGMA mmap_size = 268435456");
		}
		// (S12) Foreign keys are enabled despite the per-write cost (~10-15us per INSERT
		// for FK index lookups at 50 events/sec = ~0.5ms/sec overhead). This is a
		// deliberate trade-off: FK integrity prevents orphaned events, broken projections,
		// and silent data loss. When analyzing P11 measurements, subtract ~10-15us per
		// event for FK checks before attributing time to app logic.
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("PRAGMA busy_timeout = 5000");
		return new SqliteClient(db, maxCacheSize);
	}

	get statementCacheSize(): number {
		return this.stmtCache.size;
	}

	/** Test-only: check if a statement is in the cache. */
	hasCachedStatement(sql: string): boolean {
		return this.stmtCache.has(sql);
	}

	private prepare(sql: string): StatementSync {
		let stmt = this.stmtCache.get(sql);
		if (stmt) {
			// (Perf-Fix-2) LRU: move to end of Map iteration order so it's evicted last
			this.stmtCache.delete(sql);
			this.stmtCache.set(sql, stmt);
			return stmt;
		}

		stmt = this.db.prepare(sql);
		this.stmtCache.set(sql, stmt);

		// Evict oldest (least recently used) entries if cache exceeds capacity
		if (this.stmtCache.size > this.maxCacheSize) {
			const firstKey = this.stmtCache.keys().next().value;
			if (firstKey !== undefined) this.stmtCache.delete(firstKey);
		}

		return stmt;
	}

	execute(
		sql: string,
		params?: ReadonlyArray<SQLInputValue>,
	): { changes: number | bigint; lastInsertRowid: number | bigint } {
		const stmt = this.prepare(sql);
		return stmt.run(...(params ?? []));
	}

	query<T = Record<string, unknown>>(
		sql: string,
		params?: ReadonlyArray<SQLInputValue>,
	): T[] {
		const stmt = this.prepare(sql);
		return stmt.all(...(params ?? [])) as T[];
	}

	queryOne<T = Record<string, unknown>>(
		sql: string,
		params?: ReadonlyArray<SQLInputValue>,
	): T | undefined {
		const rows = this.query<T>(sql, params);
		return rows[0];
	}

	runInTransaction<T>(fn: () => T): T {
		if (this.transactionDepth === 0) {
			this.transactionDepth++;
			this.db.exec("BEGIN");
			try {
				const result = fn();
				this.db.exec("COMMIT");
				return result;
			} catch (err) {
				this.db.exec("ROLLBACK");
				throw err;
			} finally {
				this.transactionDepth--;
			}
		}
		const name = `sp_${++this.savepointCounter}`;
		this.transactionDepth++;
		this.db.exec(`SAVEPOINT ${name}`);
		try {
			const result = fn();
			this.db.exec(`RELEASE ${name}`);
			return result;
		} catch (err) {
			this.db.exec(`ROLLBACK TO ${name}`);
			this.db.exec(`RELEASE ${name}`);
			throw err;
		} finally {
			this.transactionDepth--;
		}
	}

	close(): void {
		if (!this.db.isOpen) return;
		this.stmtCache.clear();
		this.db.close();
	}
}
