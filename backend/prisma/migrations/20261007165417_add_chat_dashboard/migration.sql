-- CreateTable
CREATE TABLE "ChatDashboard" (
    "chatId" TEXT NOT NULL,
    "iconUrl" TEXT,
    "blocks" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatDashboard_pkey" PRIMARY KEY ("chatId")
);

-- AddForeignKey
ALTER TABLE "ChatDashboard" ADD CONSTRAINT "ChatDashboard_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
