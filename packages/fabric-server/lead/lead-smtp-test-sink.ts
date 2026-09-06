/** Loopback-only SMTP acceptance fixture. No connection or message can leave this process. */
import { createServer, Socket } from 'node:net';

export interface AcceptedTestEmail {
    from: string;
    recipients: string[];
    body: string;
}

export async function createLeadSmtpSink() {
    const messages: AcceptedTestEmail[] = [];
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        let buffer = '';
        let data = false;
        let from = '';
        let recipients: string[] = [];
        let body: string[] = [];
        socket.write('220 isolated SMTP fixture\r\n');
        socket.on('data', chunk => {
            buffer += chunk.toString();
            let end: number;
            while ((end = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (data) {
                    if (line === '.') {
                        messages.push({ from, recipients: [...recipients], body: body.join('\r\n') });
                        data = false;
                        socket.write('250 accepted by isolated sink\r\n');
                    } else body.push(line);
                } else if (/^EHLO /i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
                else if (/^AUTH PLAIN/i.test(line)) socket.write('235 local authentication accepted\r\n');
                else if (/^MAIL FROM:/i.test(line)) {
                    from = line.slice(10);
                    recipients = [];
                    body = [];
                    socket.write('250 sender accepted\r\n');
                } else if (/^RCPT TO:/i.test(line)) {
                    recipients.push(line.slice(8));
                    socket.write('250 recipient accepted\r\n');
                } else if (line === 'DATA') {
                    data = true;
                    socket.write('354 send data\r\n');
                } else if (line === 'QUIT') socket.end('221 bye\r\n');
                else socket.write('250 ok\r\n');
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('SMTP fixture address unavailable');
    return {
        messages,
        port: address.port,
        close: () =>
            new Promise<void>((resolve, reject) => {
                for (const socket of sockets) socket.destroy();
                server.close(error => (error ? reject(error) : resolve()));
            }),
    };
}
