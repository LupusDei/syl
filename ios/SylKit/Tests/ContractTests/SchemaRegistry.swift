import Foundation
import SylKit

/// Maps a schema name in `openapi.yaml` to the SylKit type that claims to model it.
///
/// The registry is the point of the whole suite. A Swift model that stops matching
/// the fixtures is the third of the three failures the contract gate catches, and the
/// one that actually bit Adjutant: the spec was right, the fixtures were right, and
/// the hand-written iOS models had drifted away from both.
enum SchemaRegistry {
    /// Decode the bytes into the named type, then encode the result back. Returning
    /// the re-encoded bytes lets the caller compare them with the original, which is
    /// what catches a `CodingKeys` typo in the *write* direction — decoding alone
    /// never exercises it, and every write here carries an idempotency key, so a
    /// wrong key name means a duplicated reminder rather than a compile error.
    static func roundTrip(_ entry: FixtureManifest.Entry, data: Data) throws -> Data {
        guard let handler = handlers[entry.schema] else {
            throw Unregistered(schema: entry.schema, file: entry.file)
        }
        return try handler(entry.envelope, data)
    }

    /// Every schema the manifest can name.
    static var registeredSchemas: Set<String> { Set(handlers.keys) }

    struct Unregistered: Error, CustomStringConvertible {
        let schema: String
        let file: String
        var description: String {
            """
            \(file) names schema \"\(schema)\", which no SylKit type claims. Either the \
            model is missing or the registry in SchemaRegistry.swift was not updated — \
            both are the drift this suite exists to catch.
            """
        }
    }

    // MARK: - Registry

    private typealias Handler = @Sendable (FixtureManifest.Entry.Envelope, Data) throws -> Data

    private static func handler<T: Codable & Equatable & Sendable>(_ type: T.Type) -> Handler {
        { envelope, data in
            let decoder = SylJSON.decoder()
            let encoder = SylJSON.encoder()
            switch envelope {
            case .ok:
                return try encoder.encode(decoder.decode(Envelope<T>.self, from: data))
            case .raw:
                return try encoder.encode(decoder.decode(T.self, from: data))
            }
        }
    }

    private static let handlers: [String: Handler] = [
        // Errors
        "ErrorEnvelope": handler(ErrorEnvelope.self),
        // Health
        "HealthStatus": handler(HealthStatus.self),
        // Auth
        "TokenGrant": handler(TokenGrant.self),
        "Principal": handler(Principal.self),
        "PairRequest": handler(PairRequest.self),
        // Conversation
        "Conversation": handler(Conversation.self),
        "ConversationPage": handler(ConversationPage.self),
        "Message": handler(Message.self),
        "MessagePage": handler(MessagePage.self),
        "SendMessageRequest": handler(SendMessageRequest.self),
        "DeliveryConfirmation": handler(DeliveryConfirmation.self),
        // Attachments
        "Attachment": handler(Attachment.self),
        "CreateAttachmentRequest": handler(CreateAttachmentRequest.self),
        // Reminders
        "Reminder": handler(Reminder.self),
        "ReminderPage": handler(ReminderPage.self),
        "CreateReminderRequest": handler(CreateReminderRequest.self),
        "UpdateReminderRequest": handler(UpdateReminderRequest.self),
        "SnoozeReminderRequest": handler(SnoozeReminderRequest.self),
        // To-dos
        "Todo": handler(Todo.self),
        "TodoPage": handler(TodoPage.self),
        "CreateTodoRequest": handler(CreateTodoRequest.self),
        "UpdateTodoRequest": handler(UpdateTodoRequest.self),
        // Goals
        "Goal": handler(Goal.self),
        "GoalPage": handler(GoalPage.self),
        "CreateGoalRequest": handler(CreateGoalRequest.self),
        // Devices
        "Device": handler(Device.self),
        "DevicePage": handler(DevicePage.self),
        "RegisterDeviceRequest": handler(RegisterDeviceRequest.self),
        // Delivery
        "Delivery": handler(Delivery.self),
        "DeliveryPage": handler(DeliveryPage.self),
        "DeliveryPayload": handler(DeliveryPayload.self),
        "AcknowledgeDeliveryRequest": handler(AcknowledgeDeliveryRequest.self),
        // Jobs and runs
        "Job": handler(Job.self),
        "JobPage": handler(JobPage.self),
        "Run": handler(Run.self),
        "RunPage": handler(RunPage.self),
        "RunStep": handler(RunStep.self),
        // Sync
        "SyncResponse": handler(SyncResponse.self),
        "SyncChange": handler(SyncChange.self),
        // WebSocket frames
        "WsAuthChallenge": handler(WsAuthChallenge.self),
        "WsAuthResponse": handler(WsAuthResponse.self),
        "WsConnected": handler(WsConnected.self),
        "WsClientChatMessage": handler(WsClientChatMessage.self),
        "WsServerChatMessage": handler(WsServerChatMessage.self),
        "WsDeliveryConfirmation": handler(WsDeliveryConfirmation.self),
        "WsPresence": handler(WsPresence.self),
        "WsSync": handler(WsSync.self),
        "WsSyncResponse": handler(WsSyncResponse.self),
        "WsPing": handler(WsPing.self),
        "WsPong": handler(WsPong.self),
        "WsError": handler(WsError.self),
    ]
}
