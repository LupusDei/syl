import Foundation

/// A fresh idempotency key.
///
/// Client-generated and opaque; a UUIDv4 is what the contract suggests. It is a
/// separate call rather than a default argument on every write so that the outbox can
/// mint one **once**, store it with the queued intent, and reuse it across every
/// retry — a key regenerated per attempt is the same as having no key at all.
public enum IdempotencyKey {
    public static func generate() -> String {
        UUID().uuidString
    }
}

/// The endpoint catalogue. One place where a path, a method and a response type meet,
/// so a typo is a compile error rather than a 404 at runtime.
public enum SylAPI {
    // MARK: - Health

    /// The one endpoint that takes no bearer token.
    public static func health() -> Endpoint<HealthStatus> {
        .get("/health", requiresAuthentication: false)
    }

    // MARK: - Auth

    public static func pair(
        _ body: PairRequest,
        idempotencyKey: String
    ) throws -> Endpoint<TokenGrant> {
        try .write(.post, "/auth/pair", body: body, idempotencyKey: idempotencyKey,
                   requiresAuthentication: false)
    }

    public static func whoami() -> Endpoint<Principal> {
        .get("/auth/whoami")
    }

    // MARK: - Conversation

    public static func conversations(
        cursor: String? = nil,
        limit: Int? = nil,
        lane: ConversationLane? = nil
    ) -> Endpoint<ConversationPage> {
        .get("/conversations", query: page(cursor: cursor, limit: limit) + optional("lane", lane?.rawValue))
    }

    public static func conversation(_ id: SylID) -> Endpoint<Conversation> {
        .get("/conversations/\(id)")
    }

    /// History, newest first. `backward` walks into the past — what a cold launch does
    /// after rendering from disk.
    public static func messages(
        conversationId: SylID,
        cursor: String? = nil,
        limit: Int? = nil,
        direction: MessageDirection? = nil
    ) -> Endpoint<MessagePage> {
        .get(
            "/conversations/\(conversationId)/messages",
            query: page(cursor: cursor, limit: limit) + optional("direction", direction?.rawValue)
        )
    }

    public enum MessageDirection: String, Sendable {
        case backward, forward
    }

    /// The HTTP send path. Used when the socket is down; reconciliation is by
    /// `clientId` and is identical either way.
    public static func sendMessage(
        conversationId: SylID,
        _ body: SendMessageRequest,
        idempotencyKey: String
    ) throws -> Endpoint<DeliveryConfirmation> {
        try .write(
            .post,
            "/conversations/\(conversationId)/messages",
            body: body,
            idempotencyKey: idempotencyKey
        )
    }

    // MARK: - Attachments

    /// Store an image or a short video and get an id for it.
    ///
    /// Two steps, always: upload here, then name the returned id in
    /// ``SendMessageRequest/attachmentIds``. An attachment exists on its own until a
    /// message claims it, which is exactly what lets a client write its local row and
    /// start the upload *before* it has a message to attach it to — `ChatViewModel`'s
    /// "disk first" rule applied to bytes.
    public static func createAttachment(
        _ body: CreateAttachmentRequest,
        idempotencyKey: String
    ) throws -> Endpoint<Attachment> {
        try .write(.post, "/attachments", body: body, idempotencyKey: idempotencyKey)
    }

    /// The **path** of the stored bytes, relative to the API base URL.
    ///
    /// Not an `Endpoint`, and that is not an oversight. `Endpoint<Response>` decodes a
    /// JSON envelope, and this is the one operation in the whole contract whose success
    /// body is not one: it answers the file, with its sniffed `Content-Type`. Every
    /// *failure* is still the ordinary error envelope, and the discriminator is the
    /// content type — JSON means Syl refused, the declared media type means these are
    /// the bytes, and anything else is a transport failure wearing an HTTP status.
    ///
    /// Ask for `.thumb` only when ``Attachment/hasThumbnail`` is true.
    public static func attachmentPath(
        _ id: SylID,
        variant: AttachmentVariant = .original
    ) -> (path: String, query: [QueryItem]) {
        (
            "/attachments/\(id)",
            variant == .original ? [] : [QueryItem("variant", variant.rawValue)]
        )
    }

    // MARK: - Reminders

    public static func reminders(
        cursor: String? = nil,
        limit: Int? = nil,
        state: ReminderDeliveryState? = nil,
        dueBefore: Date? = nil
    ) -> Endpoint<ReminderPage> {
        .get(
            "/reminders",
            query: page(cursor: cursor, limit: limit)
                + optional("state", state?.rawValue)
                + optional("dueBefore", dueBefore.map(Instant.format))
        )
    }

    public static func reminder(_ id: SylID) -> Endpoint<Reminder> {
        .get("/reminders/\(id)")
    }

    public static func createReminder(
        _ body: CreateReminderRequest,
        idempotencyKey: String
    ) throws -> Endpoint<Reminder> {
        try .write(.post, "/reminders", body: body, idempotencyKey: idempotencyKey)
    }

    public static func updateReminder(
        _ id: SylID,
        _ body: UpdateReminderRequest,
        idempotencyKey: String
    ) throws -> Endpoint<Reminder> {
        try .write(.patch, "/reminders/\(id)", body: body, idempotencyKey: idempotencyKey)
    }

    /// Rows are closed, never deleted.
    public static func cancelReminder(
        _ id: SylID,
        idempotencyKey: String
    ) -> Endpoint<Reminder> {
        .write(.delete, "/reminders/\(id)", idempotencyKey: idempotencyKey)
    }

    public static func completeReminder(
        _ id: SylID,
        idempotencyKey: String
    ) -> Endpoint<Reminder> {
        .write(.post, "/reminders/\(id)/complete", idempotencyKey: idempotencyKey)
    }

    /// Defer a reminder. **The authority is here, not on the device.**
    ///
    /// The notification action lives on the phone; the deferral does not. A phone that
    /// is wiped, restored or replaced would take device-local deferrals with it, and a
    /// deferral that vanishes is the one outcome this project forbids. The server
    /// answers `DEFERRAL_NOT_LATER` rather than accept one that would drop the row.
    public static func snoozeReminder(
        _ id: SylID,
        _ body: SnoozeReminderRequest,
        idempotencyKey: String
    ) throws -> Endpoint<Reminder> {
        try .write(.post, "/reminders/\(id)/snooze", body: body, idempotencyKey: idempotencyKey)
    }

    // MARK: - To-dos

    public static func todos(
        cursor: String? = nil,
        limit: Int? = nil,
        status: TodoStatus? = nil
    ) -> Endpoint<TodoPage> {
        .get("/todos", query: page(cursor: cursor, limit: limit) + optional("status", status?.rawValue))
    }

    public static func todo(_ id: SylID) -> Endpoint<Todo> {
        .get("/todos/\(id)")
    }

    public static func createTodo(
        _ body: CreateTodoRequest,
        idempotencyKey: String
    ) throws -> Endpoint<Todo> {
        try .write(.post, "/todos", body: body, idempotencyKey: idempotencyKey)
    }

    public static func updateTodo(
        _ id: SylID,
        _ body: UpdateTodoRequest,
        idempotencyKey: String
    ) throws -> Endpoint<Todo> {
        try .write(.patch, "/todos/\(id)", body: body, idempotencyKey: idempotencyKey)
    }

    public static func completeTodo(_ id: SylID, idempotencyKey: String) -> Endpoint<Todo> {
        .write(.post, "/todos/\(id)/complete", idempotencyKey: idempotencyKey)
    }

    // MARK: - Goals

    public static func goals(
        cursor: String? = nil,
        limit: Int? = nil,
        status: GoalStatus? = nil
    ) -> Endpoint<GoalPage> {
        .get("/goals", query: page(cursor: cursor, limit: limit) + optional("status", status?.rawValue))
    }

    public static func goal(_ id: SylID) -> Endpoint<Goal> {
        .get("/goals/\(id)")
    }

    public static func createGoal(
        _ body: CreateGoalRequest,
        idempotencyKey: String
    ) throws -> Endpoint<Goal> {
        try .write(.post, "/goals", body: body, idempotencyKey: idempotencyKey)
    }

    // MARK: - Sendings

    /// What she has sent him, newest first — the From Syl surface.
    ///
    /// A read, so no idempotency key: `Endpoint.init` traps on a write without one, and
    /// this is the one endpoint of the sendings trio the phone calls. `POST /sendings` is
    /// hers, performed by her tool server against the same door, and has no client here
    /// because the phone never composes a sending.
    ///
    /// The response is a page of complete rows whatever happened to the videos. A
    /// `pending` or `failed` sending still carries her words and its date, and a client
    /// that filters those out throws away the half of the feature that is guaranteed to
    /// have arrived.
    public static func sendings(cursor: String? = nil, limit: Int? = nil) -> Endpoint<SendingPage> {
        .get("/sendings", query: page(cursor: cursor, limit: limit))
    }

    public static func sending(_ id: SylID) -> Endpoint<Sending> {
        .get("/sendings/\(id)")
    }

    // MARK: - Devices

    public static func devices(cursor: String? = nil, limit: Int? = nil) -> Endpoint<DevicePage> {
        .get("/devices", query: page(cursor: cursor, limit: limit))
    }

    /// Register or refresh an APNs token. `environment` travels with the token because
    /// a debug build and a TestFlight build produce different ones and both exist at
    /// once; a global setting breaks one of them and the only symptom is
    /// `BadDeviceToken` on every send.
    public static func registerDevice(
        _ body: RegisterDeviceRequest,
        idempotencyKey: String
    ) throws -> Endpoint<Device> {
        try .write(.post, "/devices", body: body, idempotencyKey: idempotencyKey)
    }

    public static func unregisterDevice(_ id: SylID, idempotencyKey: String) -> Endpoint<Device> {
        .write(.delete, "/devices/\(id)", idempotencyKey: idempotencyKey)
    }

    // MARK: - Delivery

    public static func deliveries(
        cursor: String? = nil,
        limit: Int? = nil,
        state: DeliveryState? = nil,
        unacknowledged: Bool? = nil
    ) -> Endpoint<DeliveryPage> {
        .get(
            "/deliveries",
            query: page(cursor: cursor, limit: limit)
                + optional("state", state?.rawValue)
                + optional("unacknowledged", unacknowledged.map { $0 ? "true" : "false" })
        )
    }

    public static func delivery(_ id: SylID) -> Endpoint<Delivery> {
        .get("/deliveries/\(id)")
    }

    /// **The endpoint the whole delivery guarantee rests on.**
    ///
    /// APNs cannot tell us whether a notification arrived, and while a device is
    /// offline Apple retains only the most recent notification per app — so a night of
    /// reminders collapses into one. Push is therefore a notification, not the
    /// delivery mechanism, and only this call marks a row delivered.
    public static func acknowledgeDelivery(
        _ id: SylID,
        _ body: AcknowledgeDeliveryRequest,
        idempotencyKey: String
    ) throws -> Endpoint<Delivery> {
        try .write(.post, "/deliveries/\(id)/ack", body: body, idempotencyKey: idempotencyKey)
    }

    // MARK: - Sync

    /// Cursor-based catch-up for the local-first store. **Not** the WebSocket `sync`
    /// frame: this one is durable, covers every resource type, and survives a
    /// reinstall. Omit `since` for a full bootstrap and keep calling while `hasMore`.
    public static func sync(
        since: String? = nil,
        limit: Int? = nil,
        types: [SyncResourceType] = []
    ) -> Endpoint<SyncResponse> {
        var query = optional("since", since)
        if let limit { query.append(QueryItem("limit", String(limit))) }
        for type in types {
            query.append(QueryItem("types", type.rawValue))
        }
        return .get("/sync", query: query)
    }

    // MARK: - Memory

    /// A bounded region of the memory graph, shaped to be drawn as a sky.
    ///
    /// Deliberately not the admin's `/memory/graph`, which takes node seeds, edge
    /// budgets and a window of dream nights — instrument controls for judging the
    /// inferred engine. This one takes a count of stars, because the phone has no
    /// controls to turn.
    ///
    /// `stars` is refused rather than clamped when out of range (1...500): a value
    /// quietly read as the default hands back a different sky under a number the
    /// caller did not ask for.
    ///
    /// The response is a REGION. Read `bound.mayHaveMore` before implying it is
    /// everything she remembers.
    public static func constellation(stars: Int? = nil) -> Endpoint<MemoryConstellation> {
        .get("/memory/constellation", query: optional("stars", stars.map(String.init)))
    }

    // MARK: - Query helpers

    private static func page(cursor: String?, limit: Int?) -> [QueryItem] {
        optional("cursor", cursor) + optional("limit", limit.map(String.init))
    }

    private static func optional(_ name: String, _ value: String?) -> [QueryItem] {
        guard let value else { return [] }
        return [QueryItem(name, value)]
    }
}
