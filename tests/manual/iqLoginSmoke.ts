import { IqClient } from '../../src/trading/iqClient.js'

async function main() {
  const email = process.env.IQ_TEST_EMAIL
  const password = process.env.IQ_TEST_PASSWORD

  if (!email || !password) {
    throw new Error('IQ_TEST_EMAIL and IQ_TEST_PASSWORD are required')
  }

  const client = new IqClient()

  try {
    const login = await client.login(email, password)
    const demo = await client.getBalance('demo')
    const live = await client.getBalance('live')

    console.log(
      JSON.stringify(
        {
          iqUserId: login.iqUserId,
          demoBalance: demo,
          liveBalance: live,
        },
        null,
        2,
      ),
    )
  } finally {
    await client.logout()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
