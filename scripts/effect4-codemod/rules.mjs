// Reviewed one-to-one rules. The AST engine handles structural rewrites.
// These citations refer to the checked-in, version-pinned upstream reference.
const reference = (line) => `reference/v3-to-v4.md:${line}`;
const move = (path, barrel, line) => ({
	path,
	barrel,
	reference: reference(line),
});
const rename = (name, rule, line) => ({
	name,
	rule,
	reference: reference(line),
});
const skip = (reason, line) => ({ reason, reference: reference(line) });

export const importMoves = {
	"@effect/platform/ChannelSchema": move("effect/ChannelSchema", "effect", 17),
	"@effect/platform/FileSystem": move("effect/FileSystem", "effect", 18),
	"@effect/platform/Path": move("effect/Path", "effect", 20),
	"@effect/platform/Error": move("effect/PlatformError", "effect", 21),
	"@effect/platform/Terminal": move("effect/Terminal", "effect", 23),
	"@effect/experimental/DevTools": move(
		"effect/devtools/DevTools",
		"effect/devtools",
		83,
	),
	"@effect/experimental/DevTools/Client": move(
		"effect/devtools/DevToolsClient",
		"effect/devtools",
		84,
	),
	"@effect/experimental/DevTools/Domain": move(
		"effect/devtools/DevToolsSchema",
		"effect/devtools",
		85,
	),
	"@effect/experimental/DevTools/Server": move(
		"effect/devtools/DevToolsServer",
		"effect/devtools",
		86,
	),
	"@effect/platform/Ndjson": move(
		"effect/encoding/Ndjson",
		"effect/encoding",
		88,
	),
	"@effect/experimental/Sse": move(
		"effect/encoding/Sse",
		"effect/encoding",
		89,
	),
	"@effect/experimental/Event": move(
		"effect/eventlog/Event",
		"effect/eventlog",
		104,
	),
	"@effect/experimental/EventGroup": move(
		"effect/eventlog/EventGroup",
		"effect/eventlog",
		105,
	),
	"@effect/experimental/EventJournal": move(
		"effect/eventlog/EventJournal",
		"effect/eventlog",
		106,
	),
	"@effect/experimental/EventLog": move(
		"effect/eventlog/EventLog",
		"effect/eventlog",
		107,
	),
	"@effect/experimental/EventLogEncryption": move(
		"effect/eventlog/EventLogEncryption",
		"effect/eventlog",
		108,
	),
	"@effect/sql/SqlEventJournal": move(
		"effect/eventlog/SqlEventJournal",
		"effect/eventlog",
		113,
	),
	"@effect/sql/SqlEventLogServer": move(
		"effect/eventlog/SqlEventLogServerEncrypted",
		"effect/eventlog",
		114,
	),
	"@effect/platform/Cookies": move("effect/http/Cookies", "effect/http", 115),
	"@effect/platform/Etag": move("effect/http/Etag", "effect/http", 116),
	"@effect/platform/FetchHttpClient": move(
		"effect/http/FetchHttpClient",
		"effect/http",
		117,
	),
	"@effect/platform/Headers": move("effect/http/Headers", "effect/http", 118),
	"@effect/platform/HttpBody": move("effect/http/HttpBody", "effect/http", 119),
	"@effect/platform/HttpClient": move(
		"effect/http/HttpClient",
		"effect/http",
		120,
	),
	"@effect/platform/HttpClientError": move(
		"effect/http/HttpClientError",
		"effect/http",
		121,
	),
	"@effect/platform/HttpClientRequest": move(
		"effect/http/HttpClientRequest",
		"effect/http",
		122,
	),
	"@effect/platform/HttpClientResponse": move(
		"effect/http/HttpClientResponse",
		"effect/http",
		123,
	),
	"@effect/platform/HttpApp": move(
		"effect/http/HttpEffect",
		"effect/http",
		124,
	),
	"@effect/platform/HttpIncomingMessage": move(
		"effect/http/HttpIncomingMessage",
		"effect/http",
		125,
	),
	"@effect/platform/HttpMethod": move(
		"effect/http/HttpMethod",
		"effect/http",
		126,
	),
	"@effect/platform/HttpMiddleware": move(
		"effect/http/HttpMiddleware",
		"effect/http",
		127,
	),
	"@effect/platform/HttpPlatform": move(
		"effect/http/HttpPlatform",
		"effect/http",
		128,
	),
	"@effect/platform/HttpRouter": move(
		"effect/http/HttpRouter",
		"effect/http",
		129,
	),
	"@effect/platform/HttpServer": move(
		"effect/http/HttpServer",
		"effect/http",
		130,
	),
	"@effect/platform/HttpServerError": move(
		"effect/http/HttpServerError",
		"effect/http",
		131,
	),
	"@effect/platform/HttpServerRequest": move(
		"effect/http/HttpServerRequest",
		"effect/http",
		132,
	),
	"@effect/platform/HttpServerRespondable": move(
		"effect/http/HttpServerRespondable",
		"effect/http",
		133,
	),
	"@effect/platform/HttpServerResponse": move(
		"effect/http/HttpServerResponse",
		"effect/http",
		134,
	),
	"@effect/platform/HttpTraceContext": move(
		"effect/http/HttpTraceContext",
		"effect/http",
		135,
	),
	"@effect/platform/Multipart": move(
		"effect/http/Multipart",
		"effect/http",
		136,
	),
	"@effect/platform/Template": move("effect/http/Template", "effect/http", 137),
	"@effect/platform/Url": move("effect/http/Url", "effect/http", 138),
	"@effect/platform/UrlParams": move(
		"effect/http/UrlParams",
		"effect/http",
		139,
	),
	"@effect/platform/HttpApi": move(
		"effect/http-api/HttpApi",
		"effect/http-api",
		140,
	),
	"@effect/platform/HttpApiBuilder": move(
		"effect/http-api/HttpApiBuilder",
		"effect/http-api",
		141,
	),
	"@effect/platform/HttpApiClient": move(
		"effect/http-api/HttpApiClient",
		"effect/http-api",
		142,
	),
	"@effect/platform/HttpApiEndpoint": move(
		"effect/http-api/HttpApiEndpoint",
		"effect/http-api",
		143,
	),
	"@effect/platform/HttpApiError": move(
		"effect/http-api/HttpApiError",
		"effect/http-api",
		144,
	),
	"@effect/platform/HttpApiGroup": move(
		"effect/http-api/HttpApiGroup",
		"effect/http-api",
		145,
	),
	"@effect/platform/HttpApiMiddleware": move(
		"effect/http-api/HttpApiMiddleware",
		"effect/http-api",
		146,
	),
	"@effect/platform/HttpApiScalar": move(
		"effect/http-api/HttpApiScalar",
		"effect/http-api",
		147,
	),
	"@effect/platform/HttpApiSchema": move(
		"effect/http-api/HttpApiSchema",
		"effect/http-api",
		148,
	),
	"@effect/platform/HttpApiSecurity": move(
		"effect/http-api/HttpApiSecurity",
		"effect/http-api",
		149,
	),
	"@effect/platform/HttpApiSwagger": move(
		"effect/http-api/HttpApiSwagger",
		"effect/http-api",
		150,
	),
	"@effect/platform/OpenApi": move(
		"effect/http-api/OpenApi",
		"effect/http-api",
		151,
	),
	"@effect/platform/KeyValueStore": move(
		"effect/persistence/KeyValueStore",
		"effect/persistence",
		159,
	),
	"@effect/experimental/PersistedCache": move(
		"effect/persistence/PersistedCache",
		"effect/persistence",
		161,
	),
	"@effect/experimental/PersistedQueue": move(
		"effect/persistence/PersistedQueue",
		"effect/persistence",
		162,
	),
	"@effect/experimental/RateLimiter": move(
		"effect/persistence/RateLimiter",
		"effect/persistence",
		164,
	),
	"@effect/platform/Command": move(
		"effect/process/ChildProcess",
		"effect/process",
		165,
	),
	"@effect/platform/CommandExecutor": move(
		"effect/process/ChildProcessSpawner",
		"effect/process",
		166,
	),
	"@effect/experimental/Reactivity": move(
		"effect/reactivity/Reactivity",
		"effect/reactivity",
		167,
	),
	"@effect/rpc/Rpc": move("effect/rpc/Rpc", "effect/rpc", 168),
	"@effect/rpc/RpcClient": move("effect/rpc/RpcClient", "effect/rpc", 169),
	"@effect/rpc/RpcClientError": move(
		"effect/rpc/RpcClientError",
		"effect/rpc",
		170,
	),
	"@effect/rpc/RpcGroup": move("effect/rpc/RpcGroup", "effect/rpc", 171),
	"@effect/rpc/RpcMessage": move("effect/rpc/RpcMessage", "effect/rpc", 172),
	"@effect/rpc/RpcMiddleware": move(
		"effect/rpc/RpcMiddleware",
		"effect/rpc",
		173,
	),
	"@effect/rpc/RpcSchema": move("effect/rpc/RpcSchema", "effect/rpc", 174),
	"@effect/rpc/RpcSerialization": move(
		"effect/rpc/RpcSerialization",
		"effect/rpc",
		175,
	),
	"@effect/rpc/RpcServer": move("effect/rpc/RpcServer", "effect/rpc", 176),
	"@effect/rpc/RpcTest": move("effect/rpc/RpcTest", "effect/rpc", 177),
	"@effect/rpc/RpcWorker": move("effect/rpc/RpcWorker", "effect/rpc", 178),
	"@effect/experimental/VariantSchema": move(
		"effect/schema/VariantSchema",
		"effect/schema",
		180,
	),
	"@effect/platform/Socket": move("effect/socket/Socket", "effect/socket", 181),
	"@effect/platform/SocketServer": move(
		"effect/socket/SocketServer",
		"effect/socket",
		182,
	),
	"@effect/sql/Migrator": move("effect/sql/Migrator", "effect/sql", 183),
	"@effect/sql/SqlClient": move("effect/sql/SqlClient", "effect/sql", 184),
	"@effect/sql/SqlConnection": move(
		"effect/sql/SqlConnection",
		"effect/sql",
		185,
	),
	"@effect/sql/SqlError": move("effect/sql/SqlError", "effect/sql", 186),
	"@effect/sql/SqlResolver": move("effect/sql/SqlResolver", "effect/sql", 188),
	"@effect/sql/SqlSchema": move("effect/sql/SqlSchema", "effect/sql", 189),
	"@effect/sql/SqlStream": move("effect/sql/SqlStream", "effect/sql", 190),
	"@effect/sql/Statement": move("effect/sql/Statement", "effect/sql", 191),
	"@effect/platform/Transferable": move(
		"effect/workers/Transferable",
		"effect/workers",
		192,
	),
	"@effect/platform/Worker": move(
		"effect/workers/Worker",
		"effect/workers",
		193,
	),
	"@effect/platform/WorkerError": move(
		"effect/workers/WorkerError",
		"effect/workers",
		194,
	),
	"@effect/platform/WorkerRunner": move(
		"effect/workers/WorkerRunner",
		"effect/workers",
		195,
	),
	"effect/Either": move("effect/Result", "effect", 22),
	"effect/JSONSchema": move("effect/JsonSchema", "effect", 19),
	"effect/TestClock": move("effect/testing/TestClock", "effect/testing", 35),
};

export const manualImportMoves = {
	"@effect/experimental/EventLogRemote": skip(
		"The old module split into effect/eventlog/EventLogMessage, effect/eventlog/EventLogRemote; choose exports explicitly.",
		109,
	),
	"@effect/experimental/EventLogServer": skip(
		"The old module split into effect/eventlog/EventLogServer, effect/eventlog/EventLogServerEncrypted; choose exports explicitly.",
		111,
	),
	"@effect/experimental/Persistence": skip(
		"The old module split into effect/persistence/Persistable, effect/persistence/Persistence; choose exports explicitly.",
		160,
	),
	"@effect/sql/Model": skip(
		"The old module split into effect/schema/Model, effect/sql/SqlModel; choose exports explicitly.",
		179,
	),
	"@effect/platform/MsgPack": skip(
		"MessagePack was removed; SchemaBinary requires choosing a new codec contract.",
		551,
	),
	"effect/ParseResult": skip(
		"The module split into SchemaIssue and SchemaParser, with changed issue and parser contracts.",
		720,
	),
	"effect/FiberRef": skip(
		"Context.Reference replaces FiberRef with different constructors and fiber-local semantics.",
		11231,
	),
	"effect/Inspectable": skip(
		"The module split into Formatter, Inspectable and Redactable; choose exports explicitly.",
		236,
	),
};

export const renames = {
	"@effect/vitest/index": {
		scoped: rename("effect", "testing", 8685),
		scopedLive: rename("live", "testing", 8687),
	},
	"effect/Context": {
		GenericTag: rename("Service", "services", 9537),
		"Tag.Service": rename("Service.Shape", "services", 9549),
		ReadonlyTag: rename("Key", "services", 9539),
		isTag: rename("isKey", "services", 9565),
		unsafeGet: rename("getUnsafe", "services", 9567),
		unsafeMake: rename("makeUnsafe", "services", 9569),
	},
	"effect/Effect": {
		contextWithEffect: rename("contextWith", "core", 9933),
		ensureErrorType: rename("satisfiesErrorType", "core", 9959),
		ensureRequirementsType: rename("satisfiesServicesType", "core", 9961),
		ensureSuccessType: rename("satisfiesSuccessType", "core", 9963),
		tapErrorCause: rename("tapCause", "core", 10143),
		whenEffect: rename("when", "core", 10185),
		catchAll: rename("catch", "catch", 9909),
		catchAllCause: rename("catchCause", "catch", 9911),
		catchAllDefect: rename("catchDefect", "catch", 9913),
		either: rename("result", "either", 9957),
		fork: rename("forkChild", "fork", 9993),
		forkDaemon: rename("forkDetach", "fork", 9997),
	},
	"effect/Either": {
		Either: rename("Result", "either", 10271),
		Left: rename("Failure", "either", 10283),
		Right: rename("Success", "either", 10285),
		EitherTypeLambda: rename("ResultTypeLambda", "either", 10277),
		EitherUnifyIgnore: rename("ResultUnifyIgnore", "either", 10281),
		fromNullable: rename("fromNullishOr", "either", 10303),
		getLeft: rename("getFailure", "either", 10307),
		getRight: rename("getSuccess", "either", 10317),
		isEither: rename("isResult", "either", 10319),
		isLeft: rename("isFailure", "either", 10321),
		isRight: rename("isSuccess", "either", 10323),
		left: rename("fail", "either", 10325),
		mapLeft: rename("mapError", "either", 10331),
		right: rename("succeed", "either", 10335),
	},
	"effect/Layer": {
		scoped: rename("effect", "layers", 11696),
		scopedContext: rename("effectContext", "layers", 11698),
		scopedDiscard: rename("effectDiscard", "layers", 11700),
		unwrapEffect: rename("unwrap", "layers", 11734),
		unwrapScoped: rename("unwrap", "layers", 11736),
		ensureErrorType: rename("satisfiesErrorType", "layers", 11644),
		ensureRequirementsType: rename("satisfiesServicesType", "layers", 11646),
		ensureSuccessType: rename("satisfiesSuccessType", "layers", 11648),
		catchAll: rename("catch", "catch", 11632),
		catchAllCause: rename("catchCause", "catch", 11634),
	},
	"effect/Option": {
		flatMapNullable: rename("flatMapNullishOr", "option", 12858),
		fromNullable: rename("fromNullishOr", "option", 12860),
		getEquivalence: rename("makeEquivalence", "option", 12862),
		getLeft: rename("getFailure", "option", 12864),
		getOrder: rename("makeOrder", "option", 12866),
		getRight: rename("getSuccess", "option", 12868),
		liftNullable: rename("liftNullishOr", "option", 12870),
		orElseEither: rename("orElseResult", "option", 12872),
	},
	"effect/Schema": {
		JsonNumber: rename("Finite", "schema", 14374),
		Object: rename("ObjectKeyword", "schema", 14496),
		decode: rename("decodeEffect", "schema", 14810),
		decodeUnknown: rename("decodeUnknownEffect", "schema", 14814),
		encode: rename("encodeEffect", "schema", 14830),
		encodeUnknown: rename("encodeUnknownEffect", "schema", 14834),
		encodedSchema: rename("toEncoded", "schema", 14842),
		typeSchema: rename("toType", "schema", 15048),
	},
	"effect/Array": {
		flatMapNullable: rename("flatMapNullishOr", "core", 8839),
		fromNullable: rename("fromNullishOr", "core", 8841),
		getEquivalence: rename("makeEquivalence", "core", 8843),
		getLefts: rename("getFailures", "core", 8845),
		getOrder: rename("makeOrder", "core", 8847),
		getRights: rename("getSuccesses", "core", 8849),
		isEmptyArray: rename("isArrayEmpty", "core", 8853),
		isEmptyReadonlyArray: rename("isReadonlyArrayEmpty", "core", 8855),
		isNonEmptyArray: rename("isArrayNonEmpty", "core", 8857),
		isNonEmptyReadonlyArray: rename("isReadonlyArrayNonEmpty", "core", 8859),
		liftEither: rename("liftResult", "core", 8861),
		liftNullable: rename("liftNullishOr", "core", 8863),
		modifyNonEmptyHead: rename("modifyHeadNonEmpty", "core", 8865),
		modifyNonEmptyLast: rename("modifyLastNonEmpty", "core", 8867),
		modifyOption: rename("modify", "core", 8869),
		replaceOption: rename("replace", "core", 8877),
		setNonEmptyHead: rename("setHeadNonEmpty", "core", 8881),
		setNonEmptyLast: rename("setLastNonEmpty", "core", 8883),
		splitNonEmptyAt: rename("splitAtNonEmpty", "core", 8885),
		unsafeGet: rename("getUnsafe", "core", 8889),
	},
	"effect/Cause": {
		failureOption: rename("findErrorOption", "core", 9049),
		isDie: rename("hasDies", "core", 9067),
		isFailure: rename("hasFails", "core", 9079),
		isInterrupted: rename("hasInterrupts", "core", 9085),
		isInterruptedOnly: rename("hasInterruptsOnly", "core", 9089),
		isExceededCapacityException: rename(
			"isExceededCapacityError",
			"core",
			9075,
		),
		isIllegalArgumentException: rename("isIllegalArgumentError", "core", 9081),
		isNoSuchElementException: rename("isNoSuchElementError", "core", 9091),
		isTimeoutException: rename("isTimeoutError", "core", 9099),
	},
	"effect/Chunk": {
		getEquivalence: rename("makeEquivalence", "core", 9279),
		modifyOption: rename("modify", "core", 9281),
		replaceOption: rename("replace", "core", 9289),
		unsafeFromArray: rename("fromArrayUnsafe", "core", 9293),
		unsafeFromNonEmptyArray: rename("fromNonEmptyArrayUnsafe", "core", 9295),
		unsafeGet: rename("getUnsafe", "core", 9297),
		unsafeHead: rename("headUnsafe", "core", 9299),
		unsafeLast: rename("lastUnsafe", "core", 9301),
	},
	"effect/Config": {
		boolean: rename("Boolean", "core", 9335),
		date: rename("Date", "core", 9341),
		duration: rename("Duration", "core", 9343),
		integer: rename("Int", "core", 9351),
		nonEmptyString: rename("NonEmptyString", "core", 9361),
		number: rename("Number", "core", 9363),
		port: rename("Port", "core", 9371),
		string: rename("String", "core", 9381),
		url: rename("URL", "core", 9389),
	},
	"effect/DateTime": {
		unsafeMake: rename("makeUnsafe", "core", 9661),
		unsafeMakeZoned: rename("makeZonedUnsafe", "core", 9663),
		unsafeSetZoneNamed: rename("setZoneNamedUnsafe", "core", 9667),
	},
	"effect/Duration": {
		unsafeToNanos: rename("toNanosUnsafe", "core", 9801),
	},
	"effect/Exit": {
		causeOption: rename("getCause", "core", 10459),
		isInterrupted: rename("hasInterrupts", "core", 10477),
	},
	"effect/FiberHandle": {
		unsafeGet: rename("getUnsafe", "core", 11171),
	},
	"effect/FiberMap": {
		unsafeGet: rename("getUnsafe", "core", 11225),
	},
	"effect/HashMap": {
		unsafeGet: rename("getUnsafe", "core", 11478),
	},
	"effect/Ref": {
		unsafeMake: rename("makeUnsafe", "core", 13454),
	},
	"effect/SynchronizedRef": {
		unsafeMake: rename("makeUnsafe", "core", 16151),
	},
	"effect/Trie": {
		unsafeGet: rename("getUnsafe", "core", 16809),
	},
	"effect/Channel": {
		unwrapScoped: rename("unwrap", "core", 9255),
		catchAll: rename("catch", "catch", 9147),
		catchAllCause: rename("catchCause", "catch", 9149),
	},
	"effect/Stream": {
		unwrapScoped: rename("unwrap", "core", 15982),
		catchAll: rename("catch", "catch", 15718),
		catchAllCause: rename("catchCause", "catch", 15720),
	},
	"effect/Sink": {
		unwrapScoped: rename("unwrap", "core", 15558),
	},
	"@effect/platform/HttpClient": { catchAll: rename("catch", "catch", 7055) },
	"@effect/platform/Cookies": {
		unsafeMakeCookie: rename("makeCookieUnsafe", "core", 6591),
		unsafeSet: rename("setUnsafe", "core", 6593),
		unsafeSetAll: rename("setAllUnsafe", "core", 6595),
	},
	"@effect/platform/HttpServerResponse": {
		unsafeSetCookie: rename("setCookieUnsafe", "core", 7371),
		unsafeSetCookies: rename("setCookiesUnsafe", "core", 7373),
	},
};

// Entries with changed shapes or semantics are deliberately reported, never guessed.
export const manual = {
	"effect/Context": {
		Reference: skip(
			"Use Context.Reference<Shape>(id, { defaultValue }); the identifier type parameter was removed.",
			9541,
		),
		ReferenceClass: skip(
			"Replace reference subclasses with a constant created by Context.Reference.",
			9543,
		),
		TagClass: skip("Use the renamed class-style service-key type.", 9551),
		TagClassShape: skip("Use the renamed namespace type helper.", 9553),
		TagTypeId: skip("The public type identifier was renamed with Tag.", 9555),
		"Tag.Identifier": skip(
			"The pinned reference does not specify a one-to-one migration for this namespace type helper.",
			9549,
		),
	},
	"effect/Effect": {
		Service: skip(
			"Replace the `effect` constructor option with `make`. V4 does not generate a `Default` layer or wire `dependencies`; define a `Layer.effect` and provide its dependencies explicitly.",
			9845,
		),
		Tag: skip(
			"Define services with `Context.Service`; use the generated `.use` helper for accessors. Adapt arguments and imports to the v4 API.",
			9873,
		),
		catchSome: skip(
			"Replace the Option-returning partial function with a `Filter` and handler. Adapt arguments and imports to the v4 API.",
			9915,
		),
		catchSomeCause: skip(
			"Replace the Option-returning partial function with a cause `Filter` and handler. Adapt arguments and imports to the v4 API.",
			9917,
		),
		catchSomeDefect: skip(
			"Use `Effect.catchDefect` and branch explicitly, re-dying for unmatched defects. No direct public replacement exists in v4; rewrite the call site around the stated v4 primitive.",
			9919,
		),
		asyncEffect: skip(
			"The callback registration may return an Effect cleanup action in v4. Adapt arguments and imports to the v4 API.",
			9897,
		),
		descriptor: skip(
			"The full fiber descriptor was removed; retrieve the current numeric fiber id. Adapt arguments and imports to the v4 API.",
			9941,
		),
		dieMessage: skip(
			"Construct the desired defect explicitly and pass it to `Effect.die`. Adapt arguments and imports to the v4 API.",
			9945,
		),
		disconnect: skip(
			"Fork explicitly and decide how to await or interrupt the detached Fiber. Adapt arguments and imports to the v4 API.",
			9951,
		),
		exists: skip(
			"Find the first value satisfying the effectful predicate and test the returned Option. Adapt arguments and imports to the v4 API.",
			9971,
		),
		filterOrDieMessage: skip(
			"Create the message-bearing error in `filterOrFail`, then convert it to a defect. Adapt arguments and imports to the v4 API.",
			9981,
		),
		locally: skip(
			"FiberRef values are context references in v4; provide the reference for the Effect lifetime. Adapt arguments and imports to the v4 API.",
			10037,
		),
		makeSemaphore: skip(
			"Semaphore constructors moved to `effect/Semaphore`. Adapt arguments and imports to the v4 API.",
			10051,
		),
		mapInputContext: skip(
			"Build the required context from the incoming context and provide it explicitly. Adapt arguments and imports to the v4 API.",
			10057,
		),
		repeatN: skip(
			"Pass `{ times: n }` to the consolidated repeat combinator. Adapt arguments and imports to the v4 API.",
			10101,
		),
		runtime: skip(
			"Capture services as a Context and use the corresponding `run*With` function. Adapt arguments and imports to the v4 API.",
			10105,
		),
		supervised: skip(
			"Track explicitly forked Fibers in a scoped `FiberSet` instead of installing a runtime Supervisor. Adapt arguments and imports to the v4 API.",
			10131,
		),
		timeoutFail: skip(
			"Use `Effect.fail(onTimeout())` as the timeout fallback. Adapt arguments and imports to the v4 API.",
			10147,
		),
		timeoutTo: skip(
			"Map successful values first and use the timeout fallback for `onTimeout`. Adapt arguments and imports to the v4 API.",
			10151,
		),
		tracerWith: skip(
			"Use the Tracer reference's `.use` helper to invoke the effectful callback. Adapt arguments and imports to the v4 API.",
			10153,
		),
		unsafeMakeSemaphore: skip(
			"The unsafe constructor moved to `effect/Semaphore`. Adapt arguments and imports to the v4 API.",
			10171,
		),
		withMaxOpsBeforeYield: skip(
			"The scheduler operation budget is no longer configurable through Effect. No direct public replacement exists in v4; rewrite the call site around the stated v4 primitive.",
			10213,
		),
		withRuntimeFlagsPatchScoped: skip(
			"Scoped RuntimeFlags patching was removed from the public API. No direct public replacement exists in v4; rewrite the call site around the stated v4 primitive.",
			10231,
		),
		zipLeft: skip(
			"Zip the Effects and select the first tuple element. Adapt arguments and imports to the v4 API.",
			10241,
		),
	},
	"effect/Either": {
		TypeId: skip(
			"Result keeps its brand private and exports no public TypeId.",
			10287,
		),
		ap: skip(
			"Use Result.flatMap(self, (f) => Result.map(that, f)); v4 has no Result.ap.",
			10291,
		),
		filterOrLeft: skip(
			"Left is now Failure, so the predicate combinator is filterOrFail.",
			10297,
		),
		getEquivalence: skip(
			"Pass success and failure equivalences positionally instead of a right and left object.",
			10305,
		),
		getOrThrow: skip(
			"V4 throws the raw Failure value; use getOrThrowWith when a custom Error is required.",
			10311,
		),
		match: skip(
			"Rename handlers from onLeft and onRight to onFailure and onSuccess.",
			10333,
		),
	},
	"effect/Layer": {
		context: skip("Capture and return the current service context.", 11636),
		discard: skip("Build the layer while dropping its output context.", 11642),
		scope: skip("Construct and close a child scope explicitly.", 11694),
		service: skip(
			"A Context.Key is an Effect that reads and passes through its service.",
			11702,
		),
		setConfigProvider: skip(
			"Use the dedicated ConfigProvider layer constructor.",
			11706,
		),
		setTracer: skip(
			"Tracer.Tracer is now a Context.Reference; provide it directly.",
			11718,
		),
		tapErrorCause: skip(
			"The cause observer was renamed. Its callback must accept the source layer's full error cause; a callback narrowed to only part of the error union is rejected.",
			11728,
		),
		toRuntime: skip(
			"Runtime<R> was removed; build a Context, or use ManagedRuntime.make for a reusable managed runner.",
			11730,
		),
	},
	"effect/Option": {
		TypeId: skip(
			"The v4 Option brand is private and no public TypeId is exported.",
			12854,
		),
		ap: skip(
			"Use Option.zipWith(self, that, (f, a) => f(a)); v4 has no Option.ap.",
			12856,
		),
		partitionMap: skip(
			"The tuple is now [passes, fails], the reverse of v3 [left, right].",
			12874,
		),
	},
	"effect/Schema": {
		decodeEither: skip("Rename the decoder returning an `Exit`.", 14812),
		decodeUnknownEither: skip(
			"Rename the unknown-input decoder returning an `Exit`.",
			14816,
		),
		encodeEither: skip("Rename the encoder returning an `Exit`.", 14832),
		encodeUnknownEither: skip(
			"Rename the unknown-input encoder returning an `Exit`.",
			14836,
		),
		encodedBoundSchema: skip(
			"Use the encoded side of the codec; service bounds are modeled by v4 codec service types.",
			14840,
		),
		NonEmptyTrimmedString: skip(
			"Compose the trimmed schema with the non-empty check.",
			14456,
		),
		NonNegative: skip(
			"Rebuild the removed convenience schema from the v4 base schema and check APIs.",
			14462,
		),
		NonNegativeInt: skip(
			"Rebuild the removed convenience schema from the v4 base schema and check APIs.",
			14472,
		),
		NumberFromString: skip(
			'Decoding now uses JavaScript number coercion: unlike v3, `"abc"` decodes to `NaN`, while `""` and whitespace-only strings decode to `0`. `FiniteFromString` rejects non-finite results, so it rejects invalid strings but also the `"NaN"` and infinity spellings accepted by v3; it still decodes blank strings to `0`. Use a custom codec to preserve the v3 acceptance rules exactly.',
			14494,
		),
		TaggedRequest: skip(
			"The Schema request/serialization protocol was removed; migrate RPC requests to the v4 Rpc APIs.",
			14656,
		),
		between: skip(
			"Rename the predicate to `isBetween` and apply it with `Schema.check` or a schema's `check` method.",
			14786,
		),
		extend: skip(
			"Replace struct extension with `mapFields(Struct.assign(...))` or `Schema.fieldsAssign`; map union members explicitly.",
			14850,
		),
		finite: skip(
			"Rename the predicate to `isFinite` and apply it with `Schema.check` or a schema's `check` method.",
			14858,
		),
		int: skip(
			"Rename the predicate to `isInt` and apply it with `Schema.check` or a schema's `check` method.",
			14898,
		),
		minLength: skip(
			"Rename the string predicate to `isMinLength` and apply it with `Schema.check` or a schema's `check` method.",
			14942,
		),
		nonNegative: skip("Use `isGreaterThanOrEqualTo(0)` as a v4 check.", 14958),
		optionalWith: skip(
			"Choose `optional` or `optionalKey`; use the decoding-default helpers and an explicit nullable transformation as required by the old options.",
			14980,
		),
		parseJson: skip(
			"Use `fromJsonString(Schema.Unknown)` without an inner schema or `fromJsonString(schema)` with one.",
			14982,
		),
		partial: skip("Map struct fields with `Schema.optional`.", 14986),
		pattern: skip(
			"Rename the string predicate to `isPattern` and apply it with `Schema.check` or a schema's `check` method.",
			14990,
		),
		positive: skip("Use `isGreaterThan(0)` as a v4 check.", 14998),
		requiredToOptional: skip(
			"Rebuild optional-field transformations with `decodeTo` and `SchemaGetter.transformOptional`.",
			15010,
		),
		transform: skip(
			"Replace the constructor with `decodeTo` and a `SchemaTransformation`.",
			15038,
		),
		transformOrFail: skip(
			"Replace the constructor with `decodeTo` and effectful `SchemaGetter` transformations.",
			15044,
		),
	},
	"effect/Cause": {
		InterruptedException: skip(
			"The public exception class was removed. Represent cancellation with Cause.interrupt; Cause.prettyErrors creates an ordinary Error named InterruptError for interrupt-only rendering, but no class is exported.",
			9007,
		),
		UnknownException: skip(
			"Rename the class/type and discriminant. The original unknown value is now exposed through the standard Error.cause property, not v3's .error field.",
			9033,
		),
		defects: skip(
			"Collect defect values from the flat Reason array. The result is a standard array rather than v3 Chunk.",
			9045,
		),
		failures: skip(
			"Collect typed error values from the flat Reason array. The result is a standard array rather than v3 Chunk.",
			9053,
		),
		flatMap: skip(
			"No direct v4 export. Flat-map only Fail reasons into replacement causes, preserve Die/Interrupt reasons, and rebuild from the resulting Reason array.",
			9059,
		),
		isEmpty: skip(
			"V4 represents an empty cause with an empty reasons array and exports no isEmpty function.",
			9071,
		),
		isFailType: skip(
			"Apply this guard to an entry of cause.reasons; Cause itself is no longer a Fail union variant.",
			9077,
		),
		sequential: skip(
			"Combine the two flat reason arrays; v4 intentionally no longer records whether composition was parallel or sequential.",
			9115,
		),
		stripFailures: skip(
			"Remove Fail reasons and retain Die plus Interrupt reasons, then rebuild the cause. The v3 prose saying interrupts were removed did not match its implementation.",
			9121,
		),
	},
	"effect/Chunk": {
		partition: skip(
			"Return Result.succeed(value) for a match and Result.fail(value) otherwise; Filter.fromPredicate adapts predicates that only inspect the value. The tuple is now [passes, fails], the reverse of v3 [excluded, satisfying].",
			9283,
		),
		partitionMap: skip(
			"Pass a Result-returning mapper instead of Either. The tuple is [passes, fails], the reverse of v3 [failures, successes].",
			9285,
		),
		removeOption: skip(
			"The closest API now returns the unchanged Chunk out of bounds; use Chunk.get before Chunk.remove to preserve the old Option result.",
			9287,
		),
		separate: skip(
			"The tuple is now [successes, failures], the reverse of v3 [failures, successes].",
			9291,
		),
	},
	"effect/Config": {
		redacted: skip(
			"The string/path overload remains; replace the v3 Config argument overload with Config.map(config, Redacted.make).",
			9375,
		),
		option: skip(
			"Returns None for an absent config, including an all group with a missing child and no failed children. Successfully decoded undefined is wrapped in Some; validation and source errors still propagate.",
			9365,
		),
		withDefault: skip(
			"Defaults absent configs, including all groups with missing children and no failed children. A group default replaces the whole group; use defaults on children to preserve other supplied values. Validation and source errors still propagate.",
			9393,
		),
	},
	"effect/Deferred": {
		unsafeDone: skip(
			"The unsafe suffix moved to the end; the v4 function returns whether this call completed the Deferred.",
			9697,
		),
		unsafeMake: skip(
			"The unsafe suffix moved to the end, and the v4 constructor takes no FiberId argument.",
			9699,
		),
	},
	"effect/Fiber": {
		interruptFork: skip(
			"Use the immediate runtime hook for fire-and-forget interruption; Fiber.interrupt waits for cleanup.",
			11119,
		),
		status: skip(
			"FiberStatus was removed; undefined means not completed and an Exit means completed, with no public running/suspended distinction.",
			11147,
		),
	},
	"effect/FiberMap": {
		unsafeSet: skip(
			"Renamed to put the Unsafe suffix last; the interruptAs option was removed because IDs are now numeric runtime details.",
			11229,
		),
	},
	"effect/FiberRef": {
		get: skip(
			"Context.Reference is yieldable as a service; yield it directly to read the current value.",
			11285,
		),
		unsafeMake: skip(
			"Context.Reference construction is synchronous; provide a stable identifier and defaultValue.",
			11311,
		),
	},
	"effect/Logger": {
		replace: skip(
			"V4 replaces the whole active set. When replacing the old default logger, include Logger.tracerLogger explicitly if it must survive.",
			11930,
		),
		withMinimumLogLevel: skip(
			"Replace the FiberRef-local helper with reference provisioning.",
			11950,
		),
	},
	"effect/Schedule": {
		compose: skip(
			"There is no direct v4 combinator preserving this output shape. Rebuild it with Schedule.fromStep and Schedule.toStep; schedule steps now return [output, Duration] and terminate with Cause.done.",
			13984,
		),
		intersect: skip(
			"Use Schedule.max for slowest-delay composition. It outputs the selected Duration rather than a tuple of both outputs.",
			14018,
		),
		modifyDelayEffect: skip(
			"The v4 delay modifier is effectful by default and receives full Schedule.Metadata.",
			14042,
		),
		union: skip(
			"Use Schedule.min for fastest-delay composition. It outputs the selected Duration rather than both schedule outputs.",
			14090,
		),
	},
	"effect/RequestResolver": {
		contextFromEffect: skip(
			"Resolvers no longer carry an environment parameter; declare R on each Request and use entry.context inside the resolver callback.",
			13540,
		),
		makeBatched: skip(
			"make now receives a non-empty batch of Request.Entry values; read entry.request and complete every entry with completeUnsafe or Request completion helpers.",
			13548,
		),
	},
	"effect/Queue": {
		isShutdown: skip(
			"The dedicated helper was removed; inspect the public queue lifecycle state. Done includes normal completion and failure, not only explicit shutdown.",
			13268,
		),
		unsafeOffer: skip("The unsafe suffix moved to the end.", 13274),
	},
	"effect/Stream": {
		asyncPush: skip(
			"Stream.callback's register effect can use Scope for acquire/release of the external subscription, replacing asyncPush; the Emit ops helpers become plain Queue operations.",
			15690,
		),
		asyncScoped: skip(
			"Stream.callback's register effect may use Scope (Scope is excluded from the resulting R), replacing asyncScoped; the Option<E> end signal becomes Queue.end.",
			15692,
		),
		mapChunksEffect: skip(
			"Chunk->Array rename of the effectful per-chunk transform.",
			15808,
		),
		timeoutFail: skip(
			"Use `Stream.timeoutOrElse(self, { duration, orElse: () => Stream.fail(error()) })`; the timeout resets on every emitted value as before.",
			15962,
		),
	},
};
