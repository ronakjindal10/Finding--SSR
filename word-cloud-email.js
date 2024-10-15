const puppeteer = require('puppeteer');
const fs = require('fs');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const axios = require('axios');
const cheerio = require('cheerio');
const rateLimit = require('axios-rate-limit');
const axiosRetry = require('axios-retry').default;
const path = require('path');

const inputCsvFile = 'word-cloud-input.csv';
const outputCsvFile = `word-cloud-output-${Date.now()}.csv`;

const csvWriter = createCsvWriter({
    path: outputCsvFile,
    header: [
        { id: 'baseUrl', title: 'Base URL' },
        { id: 'analyzedUrl', title: 'Analyzed URL' },
        { id: 'isReact', title: 'Is React' },
        { id: 'ssrPercentage', title: 'SSR Percentage' },
        { id: 'depth', title: 'Page Depth' }
    ]
});

const http = rateLimit(axios.create(), { maxRequests: 20, perMilliseconds: 60 * 1000, maxRPS: 1 });
axiosRetry(http, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithJitter(url) {
    const jitter = Math.floor(Math.random() * 1000);
    await sleep(jitter);
    return http.get(url);
}

async function fetchSitemap(url) {
    const sitemapPaths = ['sitemap.xml', 'sitemap', 'site-map'];
    const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;

    for (const path of sitemapPaths) {
        try {
            console.log(`Attempting to fetch sitemap from ${baseUrl}/${path}...`);
            const sitemapUrl = new URL(`/${path}`, baseUrl).href;
            const response = await fetchWithJitter(sitemapUrl);

            if (path === 'sitemap.xml') {
                const parser = new require('xml2js').Parser();
                const result = await parser.parseStringPromise(response.data);
                const links = result.urlset.url.map(u => u.loc[0]);
                console.log(`XML Sitemap fetched and parsed for ${url}. Found ${links.length} links.`);
                return links;
            } else {
                const $ = cheerio.load(response.data);
                const links = $('a[href^="/"]')
                    .map((_, el) => new URL($(el).attr('href'), url).href)
                    .get()
                    .filter((value, index, self) => self.indexOf(value) === index);
                console.log(`HTML Sitemap fetched and parsed for ${url}. Found ${links.length} links.`);
                return links;
            }
        } catch (error) {
            console.error(`Error fetching sitemap from ${baseUrl}/${path}:`, error.message);
        }
    }

    console.error(`No sitemap found for ${url}. Falling back to scraping internal links from the homepage...`);
    return await scrapeInternalLinks(url);
}

async function scrapeInternalLinks(url) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0' });

    const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href^="/"]'))
            .map(a => new URL(a.href, window.location.origin).href)
            .filter((value, index, self) => self.indexOf(value) === index);
    });

    await browser.close();
    console.log(`Scraped ${links.length} internal links from the homepage`);
    return links;
}

async function detectReact(page) {
    console.log('Detecting React...');

    const isReact = await page.evaluate(() => {
        // Check for the presence of the React global variable
        if (typeof window.React !== 'undefined') {
            console.log('React detected via global variable');
            return true;
        }

        // Check for React-specific attributes in the DOM
        if (document.querySelector('[data-reactroot], [data-reactid]')) {
            console.log('React detected via data attributes');
            return true;
        }

        // Check for React root containers
        if (Array.from(document.querySelectorAll('*')).some(e => e._reactRootContainer !== undefined)) {
            console.log('React detected via root container');
            return true;
        }

        // Check for container keys
        if (Array.from(document.querySelectorAll('*')).some(e => Object.keys(e).some(k => k.startsWith('__reactContainer')))) {
            console.log('React detected via container keys');
            return true;
        }

        // Check for common React script references in HTML
        if (document.documentElement.innerHTML.includes('react.js') || 
            document.documentElement.innerHTML.includes('react.min.js') ||
            document.documentElement.innerHTML.includes('react.production.min.js') || 
            document.documentElement.innerHTML.includes('react.development.js')) {
            console.log('React detected via script references');
            return true;
        }

        // Check for common React methods in JavaScript
        const js = Array.from(document.getElementsByTagName('script'))
            .map(script => script.innerHTML)
            .join('\n');
        if (js.includes('React.createElement') || js.includes('ReactDOM.render') ||
            js.includes('window.React') || js.includes('window.__REACT_DEVTOOLS_GLOBAL_HOOK__')) {
            console.log('React detected via JavaScript methods');
            return true;
        }

        // Check for JSX syntax in JavaScript
        if (/<[A-Z][A-Za-z]*/.test(js) || document.documentElement.innerHTML.includes('<!-- react-empty: ')) {
            console.log('React detected via JSX syntax');
            return true;
        }

        // Check for Next.js specific script tag
        if (document.querySelector('script[id=__NEXT_DATA__]')) {
            console.log('Next.js detected');
            return true;
        }

        // Check for Gatsby.js specific element
        if (document.querySelector('[id=___gatsby]')) {
            console.log('Gatsby.js detected');
            return true;
        }

        console.log('React not detected');
        return false;
    });

    return isReact;
}

async function analyzeSSR(url) {
    console.log(`Analyzing SSR for ${url}...`);
    const browser = await puppeteer.launch();

    try {
        // Set viewport to mobile size
        const viewport = { width: 375, height: 667, isMobile: true, hasTouch: true };

        // Capture initial HTML with JavaScript disabled
        const pageNoJS = await browser.newPage();
        await pageNoJS.setViewport(viewport);
        await pageNoJS.setJavaScriptEnabled(false);
        await pageNoJS.goto(url, { waitUntil: 'domcontentloaded' });

        // Capture HTML with JS disabled
        const initialHtml = await pageNoJS.content();

        // Extract page title
        const pageTitle = await pageNoJS.title();

        await pageNoJS.close();

        // Capture final HTML with JavaScript enabled
        const pageWithJS = await browser.newPage();
        await pageWithJS.setViewport(viewport);
        await pageWithJS.goto(url, { waitUntil: 'networkidle0' });
        await pageWithJS.waitForTimeout(2000); // Wait for content to load

        // Capture HTML with JS enabled
        const finalHtml = await pageWithJS.content();

        await pageWithJS.close();
        await browser.close();

        // Calculate SSR percentage
        const ssrPercentage = calculateSSRPercentage(initialHtml, finalHtml);

        return {
            initialHtml,
            finalHtml,
            pageTitle,
            ssrPercentage
        };
    } catch (error) {
        console.error(`Error during SSR analysis for ${url}:`, error);
        await browser.close();
        throw error;
    }
}

function extractText(html) {
    const $ = cheerio.load(html);
    return $('body').text().replace(/\s+/g, ' ').trim();
}

function generateWordFrequencies(text) {
    const wordCounts = {};
    const words = text.toLowerCase().split(/\W+/);
    words.forEach(word => {
        // Filter out non-human-readable words
        if (
            word.length > 2 && word.length < 15 && // Exclude very short and long words
            /^[a-z]+$/.test(word) && // Only include words with letters
            !['the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'not', 'but', 'are'].includes(word) // Exclude common stop words
        ) {
            wordCounts[word] = (wordCounts[word] || 0) + 1;
        }
    });
    return wordCounts;
}

function calculateSSRPercentage(initialHtml, finalHtml) {
    const initialText = extractText(initialHtml);
    const finalText = extractText(finalHtml);

    const initialLength = initialText.length;
    const finalLength = finalText.length;

    if (finalLength === 0) return 0;

    const percentage = (initialLength / finalLength) * 100;
    return percentage.toFixed(2);
}

function isSEORelevantPage(url) {
    // Check if the URL contains keywords that indicate it's a product listing or blog page
    return /product|blog|articles|post|category|news|shop|item|service/i.test(url);
}

function selectPages(urls) {
    if (!urls || urls.length < 3) return [urls[0]];

    const homepage = urls[0];
    const relevantPages = urls.filter(isSEORelevantPage);

    // Select one relevant mid-level page and one deep-level page
    const midPage = relevantPages.length > 0 ? relevantPages[Math.floor(relevantPages.length / 2)] : urls[Math.floor(urls.length / 2)];
    const deepPage = relevantPages.length > 1 ? relevantPages[relevantPages.length - 1] : urls[urls.length - 1];

    console.log(`Selected pages: Homepage (${homepage}), Mid (${midPage}), Deep (${deepPage})`);
    return [homepage, midPage, deepPage];
}

async function analyzeWebsite(inputUrl) {
    try {
        const baseUrl = inputUrl;
        console.log(`Analyzing website: ${baseUrl}`);
        const browser = await puppeteer.launch();
        const page = await browser.newPage();
        await page.setViewport({ width: 375, height: 667, isMobile: true, hasTouch: true });
        await page.goto(baseUrl, { waitUntil: 'networkidle0' });
        const isReact = await detectReact(page);
        await browser.close();

        if (!isReact) {
            console.log(`Skipping analysis for ${baseUrl} as it is not built with React.`);
            await csvWriter.writeRecords([{
                baseUrl,
                analyzedUrl: baseUrl,
                isReact,
                ssrPercentage: 'N/A',
                depth: 'N/A'
            }]);
            return;
        }

        let results = [];
        const homepageUrl = await getHomepageUrl(baseUrl);
        const sitemapUrls = await fetchSitemap(homepageUrl);

        let lowestSSRPage = null;

        if (sitemapUrls && sitemapUrls.length > 2) {
            const [homePage, midPage, deepPage] = selectPages(sitemapUrls);

            for (const [pageUrl, depth] of [[homePage, 'Homepage'], [midPage, 'Mid'], [deepPage, 'Deep']]) {
                if (pageUrl) {
                    const { initialHtml, finalHtml, pageTitle, ssrPercentage } = await analyzeSSR(pageUrl);
                    console.log(`${depth} page (${pageUrl}) SSR Percentage: ${ssrPercentage}%`);
                    results.push({
                        baseUrl,
                        analyzedUrl: pageUrl,
                        isReact,
                        ssrPercentage,
                        depth
                    });
                    if (!lowestSSRPage || parseFloat(ssrPercentage) < parseFloat(lowestSSRPage.ssrPercentage)) {
                        lowestSSRPage = {
                            url: pageUrl,
                            ssrPercentage,
                            pageTitle,
                            initialHtml,
                            finalHtml
                        };
                    }
                }
            }
        } else {
            console.log(`Not enough pages found in the sitemap for ${homepageUrl}. Falling back to scraping internal links...`);
            const internalLinks = await scrapeInternalLinks(homepageUrl);
            if (internalLinks.length > 0) {
                const [homePage, midPage, deepPage] = selectPages(internalLinks);

                for (const [pageUrl, depth] of [[homePage, 'Homepage'], [midPage, 'Mid'], [deepPage, 'Deep']]) {
                    if (pageUrl) {
                        const { initialHtml, finalHtml, pageTitle, ssrPercentage } = await analyzeSSR(pageUrl);
                        console.log(`${depth} page (${pageUrl}) SSR Percentage: ${ssrPercentage}%`);
                        results.push({
                            baseUrl,
                            analyzedUrl: pageUrl,
                            isReact,
                            ssrPercentage,
                            depth
                        });
                        if (!lowestSSRPage || parseFloat(ssrPercentage) < parseFloat(lowestSSRPage.ssrPercentage)) {
                            lowestSSRPage = {
                                url: pageUrl,
                                ssrPercentage,
                                pageTitle,
                                initialHtml,
                                finalHtml
                            };
                        }
                    }
                }
            }
        }

        await csvWriter.writeRecords(results);
        console.log(`Analysis complete for ${baseUrl}. Results written to ${outputCsvFile}`);

        // Generate email for the page with the lowest SSR percentage
        if (lowestSSRPage) {
            const userText = extractText(lowestSSRPage.finalHtml);
            const googleText = extractText(lowestSSRPage.initialHtml);

            const userWordCounts = generateWordFrequencies(userText);
            const googleWordCounts = generateWordFrequencies(googleText);

            // Calculate the unreadable percentage based on the lowest SSR percentage
            const unreadablePercentage = (100 - parseFloat(lowestSSRPage.ssrPercentage)).toFixed(2); // Calculate the percentage

            // Pass the unreadable percentage to the createEmailWithWordCloud function
            await createEmailWithWordCloud(userWordCounts, googleWordCounts, lowestSSRPage.pageTitle, baseUrl, unreadablePercentage);
        }

    } catch (error) {
        console.error('Error analyzing website:', error);
        await csvWriter.writeRecords([{
            baseUrl: inputUrl,
            analyzedUrl: inputUrl,
            isReact: false,
            ssrPercentage: 'Error',
            depth: 'Error'
        }]);
    }
}

async function getHomepageUrl(url) {
    const parsedUrl = new URL(url);
    return `${parsedUrl.protocol}//${parsedUrl.hostname}`;
}

async function processWebsites(inputFile) {
    try {
        console.log(`Processing websites from ${inputFile}...`);
        const websites = [];
        fs.createReadStream(inputFile)
            .pipe(csv())
            .on('data', (row) => {
                websites.push(row.url);
            })
            .on('end', async () => {
                console.log(`Found ${websites.length} websites to analyze.`);
                for (const website of websites) {
                    await analyzeWebsite(website);
                }
                console.log(`Analysis complete for all websites. Results written to ${outputCsvFile}`);
            });
    } catch (error) {
        console.error('Error processing websites:', error);
    }
}

async function createEmailWithWordCloud(userWordCounts, googleWordCounts, pageTitle, baseUrl, unreadablePercentage) {
    // Prepare word data
    const allWords = new Set([...Object.keys(userWordCounts), ...Object.keys(googleWordCounts)]);

    const wordData = [];
    allWords.forEach(word => {
        const userCount = userWordCounts[word] || 0;
        const googleCount = googleWordCounts[word] || 0;

        // Only include words that appear in user's view
        if (userCount > 0) {
            wordData.push({
                word,
                weight: userCount,
                color: googleCount > 0 ? '#4CAF50' : '#808080' // Change to green and grey
            });
        }
    });

    // Generate word cloud using wordcloud2.js in a headless browser
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Word Cloud</title>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/wordcloud2.js/1.1.1/wordcloud2.min.js"></script>
      <style>
        body { margin: 0; padding: 0; }
        #word-cloud { width: 600px; height: 400px; }
      </style>
    </head>
    <body>
      <canvas id="word-cloud"></canvas>
      <script>
        const wordList = ${JSON.stringify(wordData.map(w => [w.word, w.weight, w.color]))};
        WordCloud(document.getElementById('word-cloud'), {
          list: wordList,
          weightFactor: 10,
          color: function (word, weight, fontSize, distance, theta) {
            return wordList.find(w => w[0] === word)[2];
          },
          backgroundColor: '#ffffff',
          gridSize: 8,
          rotateRatio: 0,
          drawOutOfBound: false,
          shrinkToFit: true,
        });
      </script>
    </body>
    </html>
    `;

    // Render the word cloud and capture as an image
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.setContent(htmlContent);
    await page.waitForSelector('#word-cloud');
    await page.waitForTimeout(2000); // Wait for word cloud to render

    const element = await page.$('#word-cloud');
    const wordCloudImage = await element.screenshot({ encoding: 'base64' });

    await browser.close();

    // Generate the email HTML
    const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Potential SEO Improvements for Your Website</title>
      <style type="text/css">
        /* General Styles */
        body {
          margin: 0;
          padding: 0;
          font-family: Arial, sans-serif;
          background-color: #f4f4f4;
          color: #333333;
        }
        .container {
          width: 100%;
          max-width: 600px;
          margin: 0 auto;
          background-color: #ffffff;
          padding: 20px;
        }
        .content {
          padding: 20px 0;
        }
        h1, h2, h3 {
          color: #004080;
        }
        p {
          line-height: 1.6;
        }
        .word-cloud {
          margin: 20px 0;
          text-align: center;
        }
        .word-cloud img {
          max-width: 100%;
          height: auto;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="content">
          <p>Hello,</p>
          <p>I was exploring your website and noticed that some of your content might not be fully visible to search engines like Google, which could impact your SEO performance.</p>
          <p>Here's how search engines see your page - <strong>${pageTitle}</strong>:</p>
          <div class="word-cloud">
            <img src="data:image/png;base64,${wordCloudImage}" alt="SEO improvement word cloud showing all content Google can't see for ${pageTitle}">
          </div>
          <p><strong>Google can't see any of the text in gray: approximately ${unreadablePercentage}% of your page's content.</strong></p>
          <p>Implementing server-side rendering using frameworks like Next.js can help ensure all your content is visible to search engines, improving your SEO and organic traffic.</p>
          <p>If you need technical help with understanding this or looking for alternative solutions, I am here to help.</p>
          <p>Best regards,<br>Ronak Jindal<br>Founder, <a href="https://www.camtoyou.com">Cam to You</a><br><a href="https://www.linkedin.com/in/ronakjindal">LinkedIn profile</a></p>
        </div>
      </div>
    </body>
    </html>
    `;

    // Save the email HTML to a file
    const fileName = `email_${baseUrl.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${Date.now()}.html`;
    fs.writeFileSync(fileName, emailHtml);
    console.log(`Email HTML saved as ${fileName}`);
}

// Start processing
processWebsites(inputCsvFile);