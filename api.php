<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

const MAX_PLAYERS = 6;
const INITIAL_HAND = 5;
const DECK_BASE = [
  'あ','い','う','え','お','か','き','く','け','こ',
  'さ','し','す','せ','そ','た','ち','つ','て','と',
  'な','に','ぬ','ね','の','は','ひ','ふ','へ','ほ',
  'ま','み','む','め','も','や','ゆ','よ','ら','り','る','れ','ろ','わ'
];

$DATA_DIR = __DIR__ . '/data/rooms';
if (!is_dir($DATA_DIR)) {
    mkdir($DATA_DIR, 0777, true);
}

function json_input(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function respond(array $data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function random_room_id(string $dir): string {
    for ($i = 0; $i < 20000; $i++) {
        $id = str_pad((string) random_int(0, 9999), 4, '0', STR_PAD_LEFT);
        if (!file_exists("$dir/$id.json")) return $id;
    }
    throw new RuntimeException('NO_ROOM_ID');
}

function random_player_id(): string { return 'p' . substr(bin2hex(random_bytes(4)), 0, 8); }
function random_action_id(): string { return 'a' . substr(bin2hex(random_bytes(4)), 0, 8); }

function create_deck(): array {
    $deck = [];
    for ($i = 0; $i < 3; $i++) $deck = array_merge($deck, DECK_BASE);
    shuffle($deck);
    return $deck;
}

function random_char_card(): string {
    return DECK_BASE[random_int(0, count(DECK_BASE) - 1)];
}

function public_state(array $room, string $forPlayerId): array {
    $players = array_map(function($p) use ($forPlayerId) {
        return [
            'playerId' => $p['playerId'],
            'name' => $p['name'],
            'connected' => $p['connected'],
            'handCount' => count($p['hand']),
            'hand' => $p['playerId'] === $forPlayerId ? array_values($p['hand']) : null,
            'score' => $p['score'],
        ];
    }, $room['state']['players']);

    return [
        'roomId' => $room['roomId'],
        'status' => $room['state']['status'],
        'players' => $players,
        'deckCount' => max(0, count($room['state']['deck']) - $room['state']['deckIndex']),
        'currentChar' => $room['state']['currentChar'],
        'lastPlay' => $room['state']['lastPlay'],
        'winner' => $room['state']['winner'],
        'stateVersion' => $room['state']['stateVersion'],
        'lastAction' => $room['state']['lastAction'],
    ];
}

function with_room_lock(string $roomPath, callable $fn): array {
    $fp = fopen($roomPath, 'c+');
    if (!$fp) return ['error' => 'ROOM_IO_ERROR'];
    flock($fp, LOCK_EX);
    $raw = stream_get_contents($fp);
    $room = $raw ? json_decode($raw, true) : null;
    if (!is_array($room)) {
        flock($fp, LOCK_UN);
        fclose($fp);
        return ['error' => 'ROOM_NOT_FOUND'];
    }

    $result = $fn($room);
    if (($result['mutated'] ?? false) === true) {
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($room, JSON_UNESCAPED_UNICODE));
    }

    flock($fp, LOCK_UN);
    fclose($fp);
    return $result;
}

$action = $_GET['action'] ?? '';
$payload = json_input();

if ($action === 'create_room') {
    $roomId = random_room_id($DATA_DIR);
    $deck = create_deck();
    $playerId = random_player_id();
    $name = trim((string)($payload['name'] ?? 'Player'));
    $name = mb_substr($name !== '' ? $name : 'Player', 0, 16);

    $hand = array_slice($deck, 1, INITIAL_HAND);
    $room = [
        'roomId' => $roomId,
        'state' => [
            'roomId' => $roomId,
            'status' => 'WAITING',
            'players' => [[
                'playerId' => $playerId,
                'name' => $name,
                'connected' => true,
                'hand' => $hand,
                'score' => 0,
            ]],
            'deck' => $deck,
            'deckIndex' => 1 + count($hand),
            'currentChar' => $deck[0],
            'lastPlay' => null,
            'winner' => null,
            'stateVersion' => 1,
            'lastAction' => null,
        ],
        'lastActiveAt' => time(),
    ];

    file_put_contents("$DATA_DIR/$roomId.json", json_encode($room, JSON_UNESCAPED_UNICODE));
    respond(['ok' => true, 'roomId' => $roomId, 'playerId' => $playerId, 'roomState' => public_state($room, $playerId)]);
}

$roomId = (string)($payload['roomId'] ?? '');
$roomPath = "$DATA_DIR/$roomId.json";
if ($roomId === '' || !file_exists($roomPath)) {
    respond(['ok' => false, 'reason' => 'ROOM_NOT_FOUND'], 404);
}

$result = with_room_lock($roomPath, function (&$room) use ($action, $payload) {
    $state =& $room['state'];
    $room['lastActiveAt'] = time();

    if ($action === 'join_room') {
        $connected = array_values(array_filter($state['players'], fn($p) => $p['connected']));
        if (count($connected) >= MAX_PLAYERS) return ['ok' => false, 'reason' => 'ROOM_FULL'];

        $playerId = random_player_id();
        $name = trim((string)($payload['name'] ?? 'Player'));
        $name = mb_substr($name !== '' ? $name : 'Player', 0, 16);
        $hand = [];
        for ($i = 0; $i < INITIAL_HAND && $state['deckIndex'] < count($state['deck']); $i++) {
            $hand[] = $state['deck'][$state['deckIndex']++];
        }
        $state['players'][] = ['playerId' => $playerId, 'name' => $name, 'connected' => true, 'hand' => $hand, 'score' => 0];
        if (count($connected) + 1 >= 2) $state['status'] = 'ACTIVE';
        $state['stateVersion']++;
        return ['ok' => true, 'playerId' => $playerId, 'mutated' => true, 'roomState' => public_state($room, $playerId)];
    }

    $playerId = (string)($payload['playerId'] ?? '');
    $idx = null;
    foreach ($state['players'] as $i => $p) {
        if ($p['playerId'] === $playerId) { $idx = $i; break; }
    }
    if ($idx === null) return ['ok' => false, 'reason' => 'PLAYER_NOT_FOUND'];

    if ($action === 'get_state') {
        return ['ok' => true, 'roomState' => public_state($room, $playerId)];
    }

    if ($action === 'leave_room') {
        $state['players'][$idx]['connected'] = false;
        $state['stateVersion']++;
        return ['ok' => true, 'mutated' => true, 'roomState' => public_state($room, $playerId)];
    }

    if ($action === 'play_request') {
        $endChar = trim((string)($payload['endChar'] ?? ''));
        if ($endChar === '') return ['ok' => false, 'reason' => 'INVALID_PLAY', 'roomState' => public_state($room, $playerId)];

        $hand =& $state['players'][$idx]['hand'];
        $handPos = array_search($endChar, $hand, true);
        if ($handPos === false) return ['ok' => false, 'reason' => 'CARD_NOT_OWNED', 'roomState' => public_state($room, $playerId)];

        $before = [
            'currentChar' => $state['currentChar'],
            'deckIndex' => $state['deckIndex'],
            'lastPlay' => $state['lastPlay'],
            'winner' => $state['winner'],
            'playerHand' => $hand,
            'playerScore' => $state['players'][$idx]['score'],
        ];

        array_splice($hand, (int)$handPos, 1);

        $state['currentChar'] = $endChar;
        $state['players'][$idx]['score']++;
        $state['lastPlay'] = ['playerId' => $playerId, 'name' => $state['players'][$idx]['name'], 'endChar' => $endChar, 'at' => time()];
        if (count($hand) === 0) {
            $state['winner'] = ['playerId' => $playerId, 'name' => $state['players'][$idx]['name']];
            $state['status'] = 'FINISHED';
        }

        $state['lastAction'] = [
            'actionId' => random_action_id(),
            'playerId' => $playerId,
            'before' => $before,
        ];
        $state['stateVersion']++;
        return ['ok' => true, 'mutated' => true, 'roomState' => public_state($room, $playerId)];
    }

    if ($action === 'undo_request') {
        $actionId = (string)($payload['actionId'] ?? '');
        $last = $state['lastAction'];
        if (!$last || ($last['actionId'] ?? '') !== $actionId) {
            return ['ok' => false, 'reason' => 'UNDO_NOT_AVAILABLE', 'roomState' => public_state($room, $playerId)];
        }

        $targetPid = $last['playerId'];
        $targetIdx = null;
        foreach ($state['players'] as $i => $p) {
            if ($p['playerId'] === $targetPid) { $targetIdx = $i; break; }
        }
        if ($targetIdx === null) return ['ok' => false, 'reason' => 'PLAYER_NOT_FOUND', 'roomState' => public_state($room, $playerId)];

        $before = $last['before'];
        $state['currentChar'] = $before['currentChar'];
        $state['deckIndex'] = $before['deckIndex'];
        $state['lastPlay'] = $before['lastPlay'];
        $state['winner'] = $before['winner'];
        $state['players'][$targetIdx]['hand'] = $before['playerHand'];
        $state['players'][$targetIdx]['score'] = $before['playerScore'];
        $state['status'] = $state['winner'] ? 'FINISHED' : 'ACTIVE';
        $state['lastAction'] = null;
        $state['stateVersion']++;

        return ['ok' => true, 'mutated' => true, 'roomState' => public_state($room, $playerId)];
    }

    if ($action === 'shuffle_field') {
        $state['currentChar'] = random_char_card();
        $state['lastAction'] = null;
        $state['stateVersion']++;
        return ['ok' => true, 'mutated' => true, 'roomState' => public_state($room, $playerId)];
    }

    return ['ok' => false, 'reason' => 'UNKNOWN_ACTION'];
});

respond($result, ($result['ok'] ?? false) ? 200 : 400);
