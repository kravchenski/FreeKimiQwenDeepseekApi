import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ofetch } from 'ofetch';
import FormData from 'form-data';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_URL = 'http://localhost:3264/api';

async function uploadTestFile(filePath) {
    try {
        console.log(`Загрузка файла: ${filePath}`);

        if (!fs.existsSync(filePath)) {
            throw new Error(`Файл не найден: ${filePath}`);
        }

        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath));

        const response = await ofetch(`${API_URL}/files/upload`, {
            method: 'POST',
            headers: formData.getHeaders(),
            body: formData,
            timeout: Infinity
        });

        console.log('Файл успешно загружен:');
        console.log(JSON.stringify(response, null, 2));

        return response;
    } catch (error) {
        console.error('Ошибка при загрузке файла:', error.message);
        throw error;
    }
}

async function runTest() {
    try {
        const imagePath = path.join(__dirname, 'test-image.jpg');
        const textPath = path.join(__dirname, 'test-file.txt');
        await uploadTestFile(fs.existsSync(imagePath) ? imagePath : textPath);
        console.log('\nТестирование завершено успешно!');
    } catch (error) {
        console.error('Ошибка при выполнении теста:', error.message);
    }
}

runTest();
