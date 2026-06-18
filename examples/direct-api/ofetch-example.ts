import { ofetch } from 'ofetch';

async function ofetchExample() {
    try {
        console.log('Отправка запроса через ofetch к API Qwen...\n');

        const response = await ofetch('http://localhost:3264/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: {
                messages: [
                    { role: 'system', content: 'Ты эксперт по программированию на JavaScript.' },
                    { role: 'user', content: 'Объясни, как работают асинхронные функции в JavaScript' }
                ],
                model: 'qwen-max-latest'
            }
        });

        console.log('Ответ от API:\n');
        console.log(response.choices[0].message.content);
        console.log('\nЗапрос успешно выполнен.');

        console.log('\nИнформация о запросе:');
        console.log(`ID чата: ${response.chatId}`);
        console.log(`Модель: ${response.model}`);

        const chatId = response.chatId;

        console.log('\n\nОтправка второго сообщения в тот же чат...\n');

        const followUpResponse = await ofetch('http://localhost:3264/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: {
                message: 'Приведи пример использования async/await',
                model: 'qwen-max-latest',
                chatId: chatId
            }
        });

        console.log('Ответ на второе сообщение:\n');
        console.log(followUpResponse.choices[0].message.content);

    } catch (error) {
        console.error('Ошибка при выполнении запроса:', error.message);
        if (error.data) {
            console.error('Детали ошибки:', error.data);
        }
    }
}

ofetchExample();
