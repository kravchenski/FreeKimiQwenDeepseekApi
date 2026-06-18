import { ofetch } from 'ofetch';
import { logInfo, logError, logDebug } from '../logger/index.ts';

const DASHSCOPE_API_BASE = 'https://dashscope-intl.aliyuncs.com/api/v1';

const IMAGE_GENERATION_MODELS = [
    'qwen-image-max',
    'qwen-image-plus',
    'qwen-image',
    'wan2.6-t2i',
    'wan2.5-t2i-preview',
    'wan2.2-t2i-flash'
];

export async function generateImage(prompt, model = 'qwen-image-plus', options = {}) {
    const apiKey = process.env.DASHSCOPE_API_KEY;

    if (!apiKey) {
        logError('API ключ DASHSCOPE_API_KEY не установлен');
        return {
            error: 'API ключ DASHSCOPE_API_KEY не установлен. Пожалуйста, настройте переменную окружения.'
        };
    }

    try {
        logInfo(`Генерация изображения через ${model}...`);
        logDebug(`Запрос: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`);

        const payload = {
            model: model,
            input: {
                prompt: prompt,
                negative_prompt: options.negativePrompt || ' '
            },
            parameters: {
                size: options.size || '1024*1024',
                n: options.n || 1,
                prompt_extend: options.promptExtend !== false,
                watermark: options.watermark || false
            }
        };

        const isWanModel = model.startsWith('wan');
        const endpoint = isWanModel
            ? `${DASHSCOPE_API_BASE}/services/aigc/text2image/image-synthesis`
            : `${DASHSCOPE_API_BASE}/services/aigc/text2image/image-synthesis`;

        const data = await ofetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'X-DashScope-Async': isWanModel ? 'enable' : undefined
            },
            body: payload,
            timeout: 120000
        });

        if (data.output?.task_id) {
            logInfo(`Задача создана: ${data.output.task_id}`);
            return await pollTaskStatus(data.output.task_id, apiKey);
        }

        if (data.output?.results && data.output.results.length > 0) {
            const imageUrl = data.output.results[0].url;
            logInfo(`Изображение сгенерировано: ${imageUrl}`);
            return {
                success: true,
                imageUrl: imageUrl,
                taskId: data.output.task_id,
                model: model,
                prompt: prompt
            };
        }

        return {
            error: 'Неожиданный формат ответа от API',
            rawData: data
        };

    } catch (error) {
        logError('Ошибка при генерации изображения', error);
        return {
            error: error.data?.message || error.message || 'Неизвестная ошибка'
        };
    }
}

async function pollTaskStatus(taskId, apiKey) {
    const maxAttempts = 60;
    const pollInterval = 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const task = await ofetch(`${DASHSCOPE_API_BASE}/tasks/${taskId}`, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`
                }
            });

            const taskStatus = task.output?.task_status;

            logDebug(`Статус задачи ${taskId}: ${taskStatus} (попытка ${attempt + 1}/${maxAttempts})`);

            if (taskStatus === 'SUCCEEDED') {
                const imageUrl = task.output?.results?.[0]?.url;
                if (imageUrl) {
                    logInfo(`Изображение сгенерировано: ${imageUrl}`);
                    return {
                        success: true,
                        imageUrl: imageUrl,
                        taskId: taskId,
                        model: task.input?.model || 'unknown'
                    };
                }
                return { error: 'Изображение не найдено в результате' };
            }

            if (taskStatus === 'FAILED' || taskStatus === 'CANCELLED') {
                return {
                    error: `Задача завершена со статусом: ${taskStatus}`,
                    message: task.output?.message || 'Неизвестная ошибка'
                };
            }

            await new Promise(resolve => setTimeout(resolve, pollInterval));

        } catch (error) {
            logError(`Ошибка при опросе задачи ${taskId}`, error);
            if (attempt === maxAttempts - 1) {
                return { error: `Ошибка опроса: ${error.message}` };
            }
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
    }

    return { error: 'Превышено время ожидания генерации изображения' };
}

export function getAvailableImageModels() {
    return IMAGE_GENERATION_MODELS;
}

export async function checkImageApiAvailability() {
    const apiKey = process.env.DASHSCOPE_API_KEY;

    if (!apiKey) {
        return false;
    }

    try {
        await ofetch(`${DASHSCOPE_API_BASE}/models`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            },
            timeout: 5000
        });
        return true;
    } catch (error) {
        logDebug(`API генерации изображений недоступен: ${error.message}`);
        return false;
    }
}
